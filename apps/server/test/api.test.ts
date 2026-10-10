import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hashPassword, issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

test('content API streams ranges, enforces grants, and feeds changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-api-'));
  const server = await openServer({
    dataDir: dir,
    limits: { maxUploadBytes: 1024, maxLibraryBytes: 2048, sessionTtlMs: 60_000 },
    loginLimit: 8,
  });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const ownerResponse = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    assert.equal(ownerResponse.statusCode, 201);
    const owner = ownerResponse.json() as { token: string; userId: string };
    const auth = { authorization: `Bearer ${owner.token}` };

    const libraries = await server.app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: auth,
    });
    assert.equal(libraries.statusCode, 200);
    const libraryId = (libraries.json() as { items: Array<{ id: string }> }).items[0]?.id;
    assert.ok(libraryId);

    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      headers: { ...auth, 'idempotency-key': 'item-create-1' },
      payload: {
        libraryId,
        systemIdentifier: 'com.provenance.nes',
        title: 'Range Demo',
        md5: '0123456789abcdeffedcba9876543210',
        crc: 'cbf43926',
      },
    });
    assert.equal(created.statusCode, 201);
    const replay = await server.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      headers: { ...auth, 'idempotency-key': 'item-create-1' },
      payload: {
        libraryId,
        systemIdentifier: 'com.provenance.nes',
        title: 'Range Demo',
        md5: '0123456789abcdeffedcba9876543210',
        crc: 'cbf43926',
      },
    });
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.json().id, created.json().id);
    const item = created.json() as { id: string; revision: number };

    const upload = await server.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: auth,
      payload: { libraryId },
    });
    assert.equal(upload.statusCode, 201);
    const uploadId = (upload.json() as { id: string }).id;
    const bytes = Buffer.from('abcdefghijklmnopqrstuvwxyz');
    const put = await server.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${uploadId}/content`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    assert.equal(put.statusCode, 204);
    const assetResponse = await server.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${uploadId}/complete`,
      headers: auth,
      payload: {
        itemId: item.id,
        kind: 'rom',
        displayName: 'demo.nes',
        relativePath: 'demo.nes',
        baseRevision: item.revision,
      },
    });
    assert.equal(assetResponse.statusCode, 201);
    const asset = assetResponse.json() as { id: string; sha256: string };

    const ranged = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${asset.id}/content`,
      headers: { ...auth, range: 'bytes=2-5' },
    });
    assert.equal(ranged.statusCode, 206);
    assert.equal(ranged.headers['accept-ranges'], 'bytes');
    assert.equal(ranged.headers.etag, `"${asset.sha256}"`);
    assert.equal(ranged.headers['content-range'], `bytes 2-5/${bytes.length}`);
    assert.equal(ranged.body, 'cdef');

    const unsatisfiable = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${asset.id}/content`,
      headers: { ...auth, range: 'bytes=0-1,2-3' },
    });
    assert.equal(unsatisfiable.statusCode, 400);

    const cached = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${asset.id}/content`,
      headers: { ...auth, 'if-none-match': `"${asset.sha256}"` },
    });
    assert.equal(cached.statusCode, 304);

    const biosUpload = await server.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: auth,
      payload: { libraryId },
    });
    const biosUploadId = (biosUpload.json() as { id: string }).id;
    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${biosUploadId}/content`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('bios-bytes'),
    });
    const current = await server.app.inject({
      method: 'GET',
      url: `/api/v1/items/${item.id}`,
      headers: auth,
    });
    const bios = await server.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${biosUploadId}/complete`,
      headers: auth,
      payload: {
        itemId: item.id,
        kind: 'bios',
        displayName: 'bios.bin',
        relativePath: 'bios.bin',
        baseRevision: (current.json() as { revision: number }).revision,
      },
    });
    assert.equal(bios.statusCode, 201);
    const biosId = (bios.json() as { id: string }).id;

    const guest = await server.app.inject({
      method: 'POST',
      url: '/api/v1/guest-grants',
      headers: auth,
      payload: { libraryId, capabilities: ['read'], expiresInSeconds: 3600 },
    });
    assert.equal(guest.statusCode, 201);
    const guestToken = (guest.json() as { token: string }).token;
    const guestAuth = { authorization: `Bearer ${guestToken}` };
    const guestRom = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${asset.id}/content`,
      headers: guestAuth,
    });
    assert.equal(guestRom.statusCode, 200);
    const guestBios = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${biosId}/content`,
      headers: guestAuth,
    });
    assert.equal(guestBios.statusCode, 403);

    const changes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/changes?cursor=0',
      headers: auth,
    });
    assert.equal(changes.statusCode, 200);
    assert.ok((changes.json() as { changes: unknown[] }).changes.length > 0);

    const device = await server.app.inject({
      method: 'POST',
      url: '/api/v1/device-tokens',
      headers: auth,
      payload: { name: 'tv', scopes: ['read'] },
    });
    assert.equal(device.statusCode, 201);
    assert.equal(
      server.catalog.auditContains(
        'create-device-token',
        (device.json() as { token: string }).token,
      ),
      false,
    );
    const readOnly = await server.app.inject({
      method: 'POST',
      url: '/api/v1/libraries',
      headers: { authorization: `Bearer ${(device.json() as { token: string }).token}` },
      payload: { name: 'Denied' },
    });
    assert.equal(readOnly.statusCode, 403);

    const capabilities = await server.app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    assert.equal(capabilities.statusCode, 200);
    assert.equal(capabilities.json().features.rangeRequests, true);
    assert.deepEqual(capabilities.json().features.virtualFormats, []);
    assert.equal(capabilities.headers['x-request-id'] !== undefined, true);

    await server.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: auth });
    const revoked = await server.app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: auth,
    });
    assert.equal(revoked.statusCode, 401);
    assert.equal(hashPassword('correct-horse').startsWith('$argon2id$'), true);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
