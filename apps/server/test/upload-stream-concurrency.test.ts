import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-upload-concurrency-'));
  const server = await openServer({ dataDir: dir, localTrust: false });
  const streams: PassThrough[] = [];
  t.after(async () => {
    for (const stream of streams) stream.end();
    try {
      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  const entered = new Map<string, ReturnType<typeof signal>>();
  server.app.addHook('preHandler', (request, _reply, done) => {
    // done() enters the async route up to its first await before signaling.
    // This forces competing requests past their hooks while one body is held.
    done();
    const name = request.headers['x-test-operation'];
    if (typeof name === 'string') entered.get(name)?.resolve();
  });
  const bootstrap = issueToken();
  server.catalog.saveBootstrapHash(bootstrap.hash);
  const owner = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
  });
  assert.equal(owner.statusCode, 201);
  const headers = { authorization: `Bearer ${owner.json().token}` };
  const libraries = await server.app.inject({ url: '/api/v1/libraries', headers });
  assert.equal(libraries.statusCode, 200);
  const libraryId = libraries.json().items[0].id as string;
  const item = await server.app.inject({
    method: 'POST',
    url: '/api/v1/items',
    headers,
    payload: { libraryId, systemIdentifier: 'com.provenance.nes', title: 'Concurrent upload' },
  });
  assert.equal(item.statusCode, 201);
  const upload = await server.app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers,
    payload: { libraryId },
  });
  assert.equal(upload.statusCode, 201);
  const id = upload.json().id as string;
  const url = `/api/v1/uploads/${id}`;
  function operation(name: string) {
    const ready = signal();
    entered.set(name, ready);
    return { ready: ready.promise, headers: { ...headers, 'x-test-operation': name } };
  }
  function chunk(name: string, range: string) {
    const body = new PassThrough();
    streams.push(body);
    const request = operation(name);
    const response = server.app
      .inject({
        method: 'PUT',
        url: `${url}/content`,
        headers: {
          ...request.headers,
          'content-type': 'application/octet-stream',
          'content-range': range,
        },
        payload: body,
      })
      .then((result) => result);
    return { body, response, ready: request.ready };
  }
  const completeBody = {
    itemId: item.json().id,
    kind: 'rom',
    displayName: 'generated.bin',
    relativePath: 'generated.bin',
    baseRevision: item.json().revision,
  };
  return { ...server, dir, id, url, headers, chunk, operation, completeBody };
}

test('concurrent valid and malformed chunks preserve committed bytes and recover after rejection', {
  timeout: 15000,
}, async (t) => {
  const f = await fixture(t);
  const valid = f.chunk('valid', 'bytes 0-3/8');
  await valid.ready;
  const malformed = f.chunk('malformed', 'bytes 0-3/8');
  await malformed.ready;
  valid.body.end(Buffer.from('abcd'));
  assert.equal((await valid.response).statusCode, 204);
  malformed.body.end(Buffer.from('X'));
  const rejected = await malformed.response;
  const state = await f.app.inject({ url: f.url, headers: f.headers });
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.json(), { id: f.id, received: 4, state: 'open' });
  assert.deepEqual(await readFile(join(f.dir, 'staging', f.id)), Buffer.from('abcd'));
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(rejected.json().type, 'urn:ecs:problem:upload-busy');

  // A competing retry receives a conflict; a failure releases a later corrected retry.
  const short = f.chunk('short', 'bytes 4-7/8');
  await short.ready;
  const recovery = f.chunk('recovery', 'bytes 4-7/8');
  await recovery.ready;
  short.body.end(Buffer.from('X'));
  const shortResponse = await short.response;
  assert.equal(shortResponse.statusCode, 400, shortResponse.body);
  assert.equal(shortResponse.json().type, 'urn:ecs:problem:invalid-body');
  assert.deepEqual(await readFile(join(f.dir, 'staging', f.id)), Buffer.from('abcd'));
  recovery.body.end(Buffer.from('efgh'));
  const busy = await recovery.response;
  assert.equal(busy.statusCode, 409, busy.body);
  assert.equal(busy.json().type, 'urn:ecs:problem:upload-busy');
  const retry = f.chunk('retry', 'bytes 4-7/8');
  retry.body.end(Buffer.from('efgh'));
  assert.equal((await retry.response).statusCode, 204);
  const completed = await f.app.inject({
    method: 'POST',
    url: `${f.url}/complete`,
    headers: f.headers,
    payload: f.completeBody,
  });
  assert.equal(completed.statusCode, 201, completed.body);
  assert.equal(completed.json().size, 8);
  assert.equal(completed.json().sha256, createHash('sha256').update('abcdefgh').digest('hex'));
  const content = await f.app.inject({
    url: `/api/v1/files/${completed.json().id}/content`,
    headers: f.headers,
  });
  assert.equal(content.statusCode, 200);
  assert.equal(content.body, 'abcdefgh');
  const late = f.chunk('late', 'bytes 8-8/9');
  late.body.end(Buffer.from('i'));
  const lateResponse = await late.response;
  assert.equal(lateResponse.statusCode, 409, lateResponse.body);
  assert.equal(lateResponse.json().type, 'urn:ecs:problem:upload-closed');
});

for (const finish of ['complete', 'abort'] as const) {
  test(`upload ${finish} rejects a competing mutation and succeeds after the active chunk`, {
    timeout: 15000,
  }, async (t) => {
    const f = await fixture(t);
    const valid = f.chunk('valid', 'bytes 0-3/4');
    await valid.ready;
    const request = f.operation('finish');
    const finishing = f.app
      .inject({
        method: finish === 'complete' ? 'POST' : 'DELETE',
        url: finish === 'complete' ? `${f.url}/complete` : f.url,
        headers: request.headers,
        ...(finish === 'complete' ? { payload: f.completeBody } : {}),
      })
      .then((result) => result);
    await request.ready;
    const busy = await finishing;
    assert.equal(busy.statusCode, 409, busy.body);
    assert.equal(busy.json().type, 'urn:ecs:problem:upload-busy');
    const pending = await f.app.inject({ url: f.url, headers: f.headers });
    assert.deepEqual(pending.json(), { id: f.id, received: 0, state: 'open' });
    valid.body.end(Buffer.from('abcd'));
    const written = await valid.response;
    assert.equal(written.statusCode, 204, written.body);
    const finished = await f.app.inject({
      method: finish === 'complete' ? 'POST' : 'DELETE',
      url: finish === 'complete' ? `${f.url}/complete` : f.url,
      headers: f.headers,
      ...(finish === 'complete' ? { payload: f.completeBody } : {}),
    });
    assert.equal(finished.statusCode, finish === 'complete' ? 201 : 204, finished.body);
    const state = await f.app.inject({ url: f.url, headers: f.headers });
    assert.equal(state.statusCode, 200);
    assert.deepEqual(state.json(), {
      id: f.id,
      received: 4,
      state: finish === 'complete' ? 'completed' : 'aborted',
    });
    await assert.rejects(readFile(join(f.dir, 'staging', f.id)), { code: 'ENOENT' });
    if (finish === 'complete') {
      assert.equal(finished.json().size, 4);
      assert.equal(finished.json().sha256, createHash('sha256').update('abcd').digest('hex'));
      const content = await f.app.inject({
        url: `/api/v1/files/${finished.json().id}/content`,
        headers: f.headers,
      });
      assert.equal(content.statusCode, 200);
      assert.equal(content.body, 'abcd');
    }
    const late = f.chunk('late', 'bytes 4-4/5');
    late.body.end(Buffer.from('e'));
    const rejected = await late.response;
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json().type, 'urn:ecs:problem:upload-closed');
  });
}
