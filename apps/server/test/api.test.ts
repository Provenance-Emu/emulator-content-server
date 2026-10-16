import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
      payload: { libraryId, itemId: null, capabilities: ['read'], expiresInSeconds: 3600 },
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

    const grantId = (guest.json() as { id: string }).id;
    const listed = await server.app.inject({
      method: 'GET',
      url: '/api/v1/guest-grants',
      headers: auth,
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.includes(guestToken), false);
    assert.equal(
      listed.body.includes(createHash('sha256').update(guestToken).digest('hex')),
      false,
    );
    const grantList = listed.json() as {
      items: Array<{
        id: string;
        libraryId: string;
        itemId: string | null;
        capabilities: string[];
        revokedAt: string | null;
      }>;
    };
    const found = grantList.items.find((grant) => grant.id === grantId);
    assert.ok(found);
    assert.equal(found.libraryId, libraryId);
    assert.equal(found.itemId, null);
    assert.deepEqual(found.capabilities, ['read']);
    assert.equal(found.revokedAt, null);
    assert.equal('token' in found, false);
    assert.equal('tokenHash' in found, false);
    assert.equal(JSON.stringify(found).includes(guestToken), false);

    const guestList = await server.app.inject({
      method: 'GET',
      url: '/api/v1/guest-grants',
      headers: guestAuth,
    });
    assert.equal(guestList.statusCode, 403);
    const anonymous = await server.app.inject({
      method: 'GET',
      url: '/api/v1/guest-grants',
      remoteAddress: '8.8.8.8',
    });
    assert.equal(anonymous.statusCode, 401);

    const reader = await server.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { ...auth, 'idempotency-key': 'user-reader-1' },
      payload: { username: 'reader', password: 'correct-horse' },
    });
    assert.equal(reader.statusCode, 201);
    const readerLogin = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'reader', password: 'correct-horse' },
    });
    assert.equal(readerLogin.statusCode, 200);
    const readerAuth = {
      authorization: `Bearer ${(readerLogin.json() as { token: string }).token}`,
    };
    const hidden = await server.app.inject({
      method: 'GET',
      url: '/api/v1/guest-grants',
      headers: readerAuth,
    });
    assert.equal(hidden.statusCode, 403);
    const hiddenAudit = await server.app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: readerAuth,
    });
    assert.equal(hiddenAudit.statusCode, 403);

    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/guest-grants/${grantId}`,
      headers: auth,
    });
    assert.equal(removed.statusCode, 204);
    const afterRevoke = await server.app.inject({
      method: 'GET',
      url: '/api/v1/guest-grants',
      headers: auth,
    });
    const revokedGrant = (
      afterRevoke.json() as { items: Array<{ id: string; revokedAt: string | null }> }
    ).items.find((grant) => grant.id === grantId);
    assert.equal(typeof revokedGrant?.revokedAt, 'string');
    assert.equal(afterRevoke.body.includes(guestToken), false);

    const audit = await server.app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: auth,
    });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit.body.includes(guestToken), false);
    assert.equal(
      (audit.json() as { events: Array<{ action: string }> }).events.some(
        (event) => event.action === 'revoke-guest-grant',
      ),
      true,
    );

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
    assert.deepEqual(capabilities.json().features.virtualFormats, ['zip']);
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
