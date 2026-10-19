import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
      const state = await server.app.inject({ url, headers: auth });
      assert.equal(state.json().received, 4);
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
