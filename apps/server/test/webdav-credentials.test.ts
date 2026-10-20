import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { ContentClient } from '@ecs/client';
import { openServer } from '../src/index.js';

async function fixture(enabled = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ecs-dav-api-'));
  const server = await openServer({ dataDir, webdavEnabled: enabled });
  const bootstrap = issueToken();
  server.catalog.saveBootstrapHash(bootstrap.hash);
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
  });
  assert.equal(response.statusCode, 201);
  const { token, userId } = response.json() as { token: string; userId: string };
  const headers = { authorization: `Bearer ${token}` };
  return {
    server,
    dataDir,
    headers,
    token,
    userId,
    async close() {
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
test('sessions issue/list/revoke app credentials without disclosing persistent verifiers', async () => {
  const f = await fixture();
  try {
    const address = await f.server.app.listen({ host: '127.0.0.1', port: 0 });
    const client = new ContentClient(address, f.token);
    const issued = await client.createWebdavCredential({ name: 'Finder' });
    assert.ok(issued.password.length >= 43);
    assert.ok(issued.credential.username);
    assert.equal((await client.webdavCredentials()).items[0]?.id, issued.credential.id);
    const list = await f.server.app.inject({
      method: 'GET',
      url: '/api/v1/webdav-credentials',
      headers: f.headers,
    });
    assert.equal(list.body.includes(issued.password), false);
    assert.equal(/ha1|password/i.test(list.body), false);
    assert.equal(
      f.server.catalog.auditContains('create-webdav-credential', issued.password),
      false,
    );
    const bytes = await readFile(join(f.dataDir, 'library.sqlite'));
    assert.equal(bytes.includes(Buffer.from(issued.password)), false);
    const once = await f.server.app.inject({
      method: 'POST',
      url: '/api/v1/webdav-credentials',
      headers: { ...f.headers, 'idempotency-key': 'do-not-cache-secret' },
      payload: { name: 'Once', expiresInSeconds: 60 },
    });
    assert.equal(once.statusCode, 201);
    assert.equal(once.headers['cache-control'], 'no-store');
    await client.revokeWebdavCredential(issued.credential.id);
    assert.equal(f.server.catalog.findWebDavCredential(issued.credential.username), null);
    assert.ok(
      (await client.webdavCredentials()).items.find((v) => v.id === issued.credential.id)
        ?.revokedAt,
    );
    for (const expiresInSeconds of [0, 59, 31_536_001, '60', -1]) {
      const bad = await f.server.app.inject({
        method: 'POST',
        url: '/api/v1/webdav-credentials',
        headers: f.headers,
        payload: { name: 'Bad', expiresInSeconds },
      });
      assert.equal(bad.statusCode, 400);
    }
  } finally {
    await f.close();
  }
});
test('credential management requires a real account session, never local or device authority', async () => {
  const f = await fixture();
  try {
    const device = issueToken();
    f.server.catalog.createDeviceToken({
      userId: f.userId,
      name: 'Device',
      tokenHash: device.hash,
      scopes: ['read', 'admin'],
      expiresAt: null,
    });
    for (const headers of [
      {},
      { authorization: `Bearer ${device.token}` },
      { authorization: 'Digest invalid' },
    ]) {
      for (const method of ['GET', 'POST', 'DELETE'] as const) {
        const response = await f.server.app.inject({
          method,
          url:
            method === 'DELETE'
              ? '/api/v1/webdav-credentials/unknown'
              : '/api/v1/webdav-credentials',
          headers,
          ...(method === 'POST' ? { payload: { name: 'Denied' } } : {}),
        });
        assert.ok([401, 403].includes(response.statusCode));
      }
    }
    const other = f.server.catalog.createUser({
      username: 'other',
      passwordHash: 'fixture',
      actorId: f.userId,
    });
    const issued = await f.server.app.inject({
      method: 'POST',
      url: '/api/v1/webdav-credentials',
      headers: f.headers,
      payload: { name: 'Finder' },
    });
    const credential = issued.json().credential as { id: string };
    const otherToken = issueToken();
    f.server.catalog.createSession(other.id, otherToken.hash);
    const denied = await f.server.app.inject({
      method: 'DELETE',
      url: `/api/v1/webdav-credentials/${credential.id}`,
      headers: { authorization: `Bearer ${otherToken.token}` },
    });
    assert.equal(denied.statusCode, 404);
  } finally {
    await f.close();
  }
});
test('disabled mounts refuse credential issuance but permit session listing', async () => {
  const f = await fixture(false);
  try {
    assert.equal(
      (
        await f.server.app.inject({
          method: 'POST',
          url: '/api/v1/webdav-credentials',
          headers: f.headers,
          payload: { name: 'Finder' },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.server.app.inject({
          method: 'GET',
          url: '/api/v1/webdav-credentials',
          headers: f.headers,
        })
      ).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});
