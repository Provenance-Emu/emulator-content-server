import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

test('range errors never return file bytes and leave valid reads intact', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-ranges-'));
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
  const auth = { authorization: `Bearer ${owner.json().token}` };
  const libraries = await app.inject({ url: '/api/v1/libraries', headers: auth });
  assert.equal(libraries.statusCode, 200);
  const libraryId = libraries.json().items[0].id as string;
  const item = await app.inject({
    method: 'POST',
    url: '/api/v1/items',
    headers: auth,
    payload: { libraryId, systemIdentifier: 'com.provenance.nes', title: 'Generated range bytes' },
  });
  assert.equal(item.statusCode, 201);
  const upload = await app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: auth,
    payload: { libraryId },
  });
  assert.equal(upload.statusCode, 201);
  const put = await app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${upload.json().id}/content`,
    headers: { ...auth, 'content-type': 'application/octet-stream' },
    payload: Buffer.from('abcdefghij'),
  });
  assert.equal(put.statusCode, 204);
  const complete = await app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${upload.json().id}/complete`,
    headers: auth,
    payload: {
      itemId: item.json().id,
      kind: 'rom',
      displayName: 'generated.bin',
      relativePath: 'generated.bin',
      baseRevision: item.json().revision,
    },
  });
  assert.equal(complete.statusCode, 201);
  const url = `/api/v1/files/${complete.json().id}/content`;
  const etag = `"${complete.json().sha256}"`;

  // Exercise HEAD over HTTP: injection retains serialized error bodies.
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });

  for (const method of ['GET', 'HEAD'] as const) {
    for (const range of [
      'bytes=0-1,4-5',
      'bytes=0-3,2-5',
      'bytes=-2,-4',
      'bytes=0-1,100-',
      'bytes=100-,200-',
    ]) {
      await t.test(`${method} rejects multiple ranges: ${range}`, async () => {
        const response = await fetch(`${origin}${url}`, { method, headers: { ...auth, range } });
        assert.equal(response.status, 400);
        assert.equal(response.headers.get('content-range'), null);
        assert.equal(response.headers.get('accept-ranges'), 'bytes');
        assert.equal(response.headers.get('etag'), etag);
        if (method === 'GET') {
          assert.match(String(response.headers.get('content-type')), /^application\/problem\+json/);
          assert.equal(
            ((await response.json()) as { type: string }).type,
            'urn:ecs:problem:invalid-range',
          );
        } else {
          assert.equal(await response.text(), '');
        }
      });
    }
    for (const range of ['bytes=10-', 'bytes=10-20', 'bytes=100-', 'bytes=9007199254740991-']) {
      await t.test(`${method} rejects an out-of-bounds range: ${range}`, async () => {
        const response = await fetch(`${origin}${url}`, { method, headers: { ...auth, range } });
        assert.equal(response.status, 416);
        assert.equal(response.headers.get('content-range'), 'bytes */10');
        assert.equal(response.headers.get('accept-ranges'), 'bytes');
        assert.equal(response.headers.get('etag'), etag);
        assert.equal(await response.text(), '');
      });
    }
  }

  for (const input of [
    { range: 'bytes=8-99', contentRange: 'bytes 8-9/10', body: 'ij' },
    { range: 'bytes=8-', contentRange: 'bytes 8-9/10', body: 'ij' },
    { range: 'bytes=-3', contentRange: 'bytes 7-9/10', body: 'hij' },
  ]) {
    const response = await fetch(`${origin}${url}`, { headers: { ...auth, range: input.range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), input.contentRange);
    assert.equal(response.headers.get('content-length'), String(input.body.length));
    assert.equal(await response.text(), input.body);
  }
  const full = await fetch(`${origin}${url}`, { headers: auth });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-range'), null);
  assert.equal(await full.text(), 'abcdefghij');
});
