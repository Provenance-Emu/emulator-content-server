import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { ContentClient, ContentError } from '@ecs/client';
import { blobPath } from '@ecs/storage';
import { openServer } from '../src/index.js';

test('a secondary location is readable as a range, and offline is not a missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-server-location-'));
  const extra = join(dir, 'extra');
  await mkdir(extra);
  const dataDir = join(dir, 'data');
  const server = await openServer({
    dataDir,
    limits: { maxUploadBytes: 1024, maxLibraryBytes: 4096, sessionTtlMs: 60_000 },
  });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const owner = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    const auth = { authorization: `Bearer ${(owner.json() as { token: string }).token}` };
    const libraries = await server.app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: auth,
    });
    const libraryId = (libraries.json() as { items: Array<{ id: string }> }).items[0]?.id;
    assert.ok(libraryId);
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      headers: auth,
      payload: { libraryId, systemIdentifier: 'com.provenance.nes', title: 'Split' },
    });
    const item = created.json() as { id: string; revision: number };
    const primary = await upload(
      server,
      auth,
      libraryId,
      item.id,
      item.revision,
      'primary.nes',
      'abcd',
    );

    const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const client = new ContentClient(address, auth.authorization.slice(7));
    const revision = async () => {
      const row = (await client.items({ libraryId })).items.find((entry) => entry.id === item.id);
      assert.ok(row);
      return row.revision;
    };
    const location = await client.addStorageLocation({ path: extra, label: 'Extra' });
    await client.setStorageWriteTarget(location.id);
    const current = await server.app.inject({
      method: 'GET',
      url: `/api/v1/items/${item.id}`,
      headers: auth,
    });
    const secondary = await upload(
      server,
      auth,
      libraryId,
      item.id,
      (current.json() as { revision: number }).revision,
      'secondary.nes',
      'wxyz',
    );

    await stat(blobPath(extra, secondary.sha256));
    await assert.rejects(stat(blobPath(dataDir, secondary.sha256)));
    const ranged = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${secondary.id}/content`,
      headers: { ...auth, range: 'bytes=1-2' },
    });
    assert.equal(ranged.statusCode, 206);
    assert.equal(ranged.body, 'xy');

    const duplicate = await client.upload({
      libraryId,
      itemId: item.id,
      kind: 'rom',
      displayName: 'duplicate',
      relativePath: 'duplicate',
      baseRevision: await revision(),
      body: new TextEncoder().encode('abcd'),
    });
    assert.equal(duplicate.sha256, primary.sha256);
    assert.equal(server.catalog.blobRecord(primary.sha256)?.locationId, null);
    await assert.rejects(stat(blobPath(extra, primary.sha256)));
    await client.setStorageWriteTarget(null);
    const restored = await client.upload({
      libraryId,
      itemId: item.id,
      kind: 'rom',
      displayName: 'restored',
      relativePath: 'restored',
      baseRevision: await revision(),
      body: new TextEncoder().encode('mnop'),
    });
    await stat(blobPath(dataDir, restored.sha256));
    await assert.rejects(stat(blobPath(extra, restored.sha256)));
    await client.setStorageWriteTarget(location.id);
    await rename(extra, join(dir, 'extra-offline'));
    await assert.rejects(
      client.upload(
        {
          libraryId,
          itemId: item.id,
          kind: 'rom',
          displayName: 'offline',
          relativePath: 'offline',
          baseRevision: await revision(),
          body: new TextEncoder().encode('qrst'),
        },
        1,
      ),
      (error: unknown) =>
        error instanceof ContentError &&
        error.status === 503 &&
        error.problem?.type === 'urn:ecs:problem:location-offline',
    );
    const offline = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${secondary.id}/content`,
      headers: auth,
    });
    assert.equal(offline.statusCode, 503);
    assert.equal((offline.json() as { type: string }).type, 'urn:ecs:problem:location-offline');
    const still = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${primary.id}/content`,
      headers: { ...auth, range: 'bytes=0-3' },
    });
    assert.equal(still.statusCode, 206);
    assert.equal(still.body, 'abcd');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function upload(
  server: Awaited<ReturnType<typeof openServer>>,
  auth: { authorization: string },
  libraryId: string,
  itemId: string,
  baseRevision: number,
  name: string,
  text: string,
): Promise<{ id: string; sha256: string }> {
  const opened = await server.app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: auth,
    payload: { libraryId },
  });
  const uploadId = (opened.json() as { id: string }).id;
  const put = await server.app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${uploadId}/content`,
    headers: { ...auth, 'content-type': 'application/octet-stream' },
    payload: Buffer.from(text),
  });
  assert.equal(put.statusCode, 204);
  const completed = await server.app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${uploadId}/complete`,
    headers: auth,
    payload: {
      itemId,
      kind: 'rom',
      displayName: name,
      relativePath: name,
      baseRevision,
    },
  });
  assert.equal(completed.statusCode, 201, completed.body);
  return completed.json() as { id: string; sha256: string };
}
