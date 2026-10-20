import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-upload-concurrency-'));
  let server: Awaited<ReturnType<typeof openServer>> | undefined;
  t.after(async () => {
    try {
      await server?.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  server = await openServer({ dataDir: dir, localTrust: false });
  const { app } = server;
  const bootstrap = issueToken();
  server.catalog.saveBootstrapHash(bootstrap.hash);
  const owner = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
  });
  assert.equal(owner.statusCode, 201);
  const headers = { authorization: `Bearer ${owner.json().token}` };
  const libraries = await app.inject({ url: '/api/v1/libraries', headers });
  assert.equal(libraries.statusCode, 200);
  const libraryId = libraries.json().items[0].id as string;
  const item = await app.inject({
    method: 'POST',
    url: '/api/v1/items',
    headers,
    payload: { libraryId, systemIdentifier: 'com.provenance.nes', title: 'Concurrent upload' },
  });
  assert.equal(item.statusCode, 201);
  const newUpload = async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers,
      payload: { libraryId },
    });
    assert.equal(response.statusCode, 201);
    return `/api/v1/uploads/${response.json().id}`;
  };
  const url = await newUpload();
  const put = (target: string, start: number, bytes: string) =>
    app.inject({
      method: 'PUT',
      url: `${target}/content`,
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${start + bytes.length - 1}/8`,
      },
      payload: Buffer.from(bytes),
    });
  assert.equal((await put(url, 0, 'head')).statusCode, 204);
  const complete = (key?: string) =>
    app.inject({
      method: 'POST',
      url: `${url}/complete`,
      headers: key ? { ...headers, 'idempotency-key': key } : headers,
      payload: {
        itemId: item.json().id,
        kind: 'rom',
        relativePath: 'generated.bin',
        displayName: 'generated.bin',
        baseRevision: item.json().revision,
      },
    });
  return { app, headers, url, put, complete, newUpload };
}

test('simultaneous chunks at one offset cannot overwrite the winning bytes', async (t) => {
  const { app, headers, url, put, complete } = await setup(t);
  const responses = await Promise.all([put(url, 4, 'AAAA'), put(url, 4, 'BBBB')]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [204, 409]);
  const winner = responses[0]?.statusCode === 204 ? 'AAAA' : 'BBBB';
  const state = await app.inject({ url, headers });
  assert.equal(state.statusCode, 200);
  assert.equal(state.json().received, 8);
  const completed = await complete();
  assert.equal(completed.statusCode, 201, completed.body);
  const bytes = await app.inject({ url: `/api/v1/files/${completed.json().id}/content`, headers });
  assert.equal(bytes.statusCode, 200);
  assert.equal(bytes.body, `head${winner}`);
});

for (const operation of ['complete', 'abort'] as const) {
  test(`a chunk cannot race ${operation} into an inconsistent upload`, async (t) => {
    const { app, headers, url, put, complete } = await setup(t);
    const [chunk, other] = await Promise.all([
      put(url, 4, 'tail'),
      operation === 'complete' ? complete() : app.inject({ method: 'DELETE', url, headers }),
    ]);
    assert.ok(chunk && other);
    const operationStatus = operation === 'complete' ? 201 : 204;
    assert.ok(
      (chunk.statusCode === 204 && other.statusCode === 409) ||
        (chunk.statusCode === 409 && other.statusCode === operationStatus),
      `unexpected statuses ${chunk.statusCode}, ${other.statusCode}`,
    );
    if (operation === 'complete') {
      const completed = other.statusCode === 201 ? other : await complete();
      assert.equal(completed.statusCode, 201, completed.body);
      const bytes = await app.inject({
        url: `/api/v1/files/${completed.json().id}/content`,
        headers,
      });
      assert.equal(bytes.statusCode, 200);
      assert.equal(bytes.body, chunk.statusCode === 204 ? 'headtail' : 'head');
    } else {
      if (other.statusCode !== 204) {
        assert.equal((await app.inject({ method: 'DELETE', url, headers })).statusCode, 204);
      }
      const state = await app.inject({ url, headers });
      assert.equal(state.statusCode, 200);
      assert.equal(state.json().state, 'aborted');
      const lateChunk = await put(url, 4, 'late');
      assert.equal(lateChunk.statusCode, 409);
      assert.equal(lateChunk.json().type, 'urn:ecs:problem:upload-closed');
      const lateComplete = await complete();
      assert.equal(lateComplete.statusCode, 409);
      assert.equal(lateComplete.json().type, 'urn:ecs:problem:upload-closed');
    }
  });
}

test('different completion keys cannot operate on the same upload concurrently', async (t) => {
  const { complete } = await setup(t);
  const responses = await Promise.all([
    complete('completion-key-one'),
    complete('completion-key-two'),
  ]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  const winner = responses[0]?.statusCode === 201 ? 0 : 1;
  const replay = await complete(winner === 0 ? 'completion-key-one' : 'completion-key-two');
  assert.equal(replay.statusCode, 201);
  assert.deepEqual(replay.json(), responses[winner]?.json());
});

test('a completed upload refuses late chunks before touching deleted staging bytes', async (t) => {
  const { url, put, complete } = await setup(t);
  assert.equal((await complete()).statusCode, 201);
  const late = await put(url, 4, 'late');
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().type, 'urn:ecs:problem:upload-closed');
});

test('unrelated uploads can accept chunks at the same time', async (t) => {
  const { url, put, newUpload } = await setup(t);
  const second = await newUpload();
  const results = await Promise.all([put(url, 4, 'tail'), put(second, 0, 'head')]);
  assert.deepEqual(
    results.map((response) => response.statusCode),
    [204, 204],
  );
});
