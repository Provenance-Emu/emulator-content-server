import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

// These requests catch accepting malformed chunks or overwriting committed bytes.
for (const input of [
  { name: 'overlapping', range: 'bytes 2-3/10', bytes: 'XY', status: 409 },
  { name: 'gapped', range: 'bytes 6-7/10', bytes: 'XY', status: 409 },
  { name: 'longer than declared', range: 'bytes 4-5/10', bytes: 'XYZ', status: 400 },
  { name: 'shorter than declared', range: 'bytes 4-7/10', bytes: 'XY', status: 400 },
  { name: 'ending at the total', range: 'bytes 4-5/5', bytes: 'XY', status: 400 },
  { name: 'ending past the total', range: 'bytes 4-5/4', bytes: 'XY', status: 400 },
  { name: 'with a zero total', range: 'bytes 4-5/0', bytes: 'XY', status: 400 },
]) {
  test(`a chunk ${input.name} preserves the committed upload prefix`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ecs-upload-validation-'));
    const server = await openServer({ dataDir: dir });
    try {
      const bootstrap = issueToken();
      server.catalog.saveBootstrapHash(bootstrap.hash);
      const owner = await server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
      });
      assert.equal(owner.statusCode, 201);
      const auth = { authorization: `Bearer ${owner.json().token}` };
      const libraries = await server.app.inject({ url: '/api/v1/libraries', headers: auth });
      const libraryId = libraries.json().items[0].id as string;
      const item = await server.app.inject({
        method: 'POST',
        url: '/api/v1/items',
        headers: auth,
        payload: { libraryId, systemIdentifier: 'com.provenance.nes', title: 'Upload validation' },
      });
      assert.equal(item.statusCode, 201);
      const upload = await server.app.inject({
        method: 'POST',
        url: '/api/v1/uploads',
        headers: auth,
        payload: { libraryId },
      });
      assert.equal(upload.statusCode, 201);
      const url = `/api/v1/uploads/${upload.json().id}`;
      const send = (range: string, bytes: string) =>
        server.app.inject({
          method: 'PUT',
          url: `${url}/content`,
          headers: { ...auth, 'content-type': 'application/octet-stream', 'content-range': range },
          payload: Buffer.from(bytes),
        });
      assert.equal((await send('bytes 0-3/10', 'abcd')).statusCode, 204);
      const rejected = await send(input.range, input.bytes);
      assert.equal(rejected.statusCode, input.status, rejected.body);
      assert.equal(
        rejected.json().type,
        input.status === 409 ? 'urn:ecs:problem:upload-gap' : 'urn:ecs:problem:invalid-body',
      );
      const state = await server.app.inject({ url, headers: auth });
      assert.equal(state.statusCode, 200);
      assert.deepEqual(state.json(), { id: upload.json().id, received: 4, state: 'open' });
      assert.deepEqual(await readFile(join(dir, 'staging', upload.json().id)), Buffer.from('abcd'));
      assert.equal((await send('bytes 4-9/10', 'efghij')).statusCode, 204);
      const complete = await server.app.inject({
        method: 'POST',
        url: `${url}/complete`,
        headers: auth,
        payload: {
          itemId: item.json().id,
          kind: 'rom',
          displayName: 'generated.bin',
          relativePath: 'generated.bin',
          baseRevision: item.json().revision,
        },
      });
      assert.equal(complete.statusCode, 201, complete.body);
      const content = await server.app.inject({
        url: `/api/v1/files/${complete.json().id}/content`,
        headers: auth,
      });
      assert.equal(content.statusCode, 200);
      assert.equal(content.body, 'abcdefghij');
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('upload completion rejects 1025-character paths without mutation and accepts 1024', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-upload-path-'));
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
    payload: { libraryId, systemIdentifier: 'com.provenance.nes', title: 'Path boundary' },
  });
  assert.equal(item.statusCode, 201);
  const upload = await app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers,
    payload: { libraryId },
  });
  assert.equal(upload.statusCode, 201);
  const url = `/api/v1/uploads/${upload.json().id}`;
  const bytes = Buffer.from('generated path-boundary bytes');
  const put = await app.inject({
    method: 'PUT',
    url: `${url}/content`,
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
  assert.equal(put.statusCode, 204);
  const before = await app.inject({ url, headers });
  assert.equal(before.statusCode, 200);
  const manifestUrl = `/api/v1/items/${item.json().id}/manifest`;
  const manifestBefore = await app.inject({ url: manifestUrl, headers });
  assert.equal(manifestBefore.statusCode, 200);
  assert.deepEqual(manifestBefore.json().files, []);
  const path1024 = `${'a/'.repeat(500)}${'b'.repeat(24)}`;
  const complete = (relativePath: string) =>
    app.inject({
      method: 'POST',
      url: `${url}/complete`,
      headers,
      payload: {
        itemId: item.json().id,
        kind: 'rom',
        displayName: 'generated.bin',
        relativePath,
        baseRevision: item.json().revision,
      },
    });
  const rejected = await complete(`${path1024}b`);
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.equal(rejected.json().type, 'urn:ecs:problem:invalid-body');
  const after = await app.inject({ url, headers });
  assert.equal(after.statusCode, 200);
  assert.deepEqual(after.json(), before.json());
  assert.deepEqual(await readFile(join(dir, 'staging', upload.json().id)), bytes);
  const manifestAfter = await app.inject({ url: manifestUrl, headers });
  assert.equal(manifestAfter.statusCode, 200);
  assert.deepEqual(manifestAfter.json(), manifestBefore.json());

  const accepted = await complete(path1024);
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal(accepted.json().relativePath, path1024);
  const manifest = await app.inject({ url: manifestUrl, headers });
  assert.equal(manifest.statusCode, 200);
  assert.deepEqual(
    manifest.json().files.map((file: { relativePath: string }) => file.relativePath),
    [path1024],
  );
  const content = await app.inject({ url: `/api/v1/files/${accepted.json().id}/content`, headers });
  assert.equal(content.statusCode, 200);
  assert.deepEqual(content.rawPayload, bytes);
});
