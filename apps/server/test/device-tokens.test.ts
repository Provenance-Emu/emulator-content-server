import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hashToken, issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

test('device listing stays user-scoped, never discloses secrets, and revocation stops access', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ecs-device-api-'));
  const server = await openServer({ dataDir, localTrust: false });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'generated-password' },
    });
    const headers = { authorization: `Bearer ${created.json().token}` };
    const other = await server.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers,
      payload: { username: 'reader', password: 'generated-password' },
    });
    assert.equal(other.statusCode, 201);
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'reader', password: 'generated-password' },
    });
    const readerHeaders = { authorization: `Bearer ${login.json().token}` };
    const issued = await server.app.inject({
      method: 'POST',
      url: '/api/v1/device-tokens',
      headers,
      payload: { name: 'Generated device', scopes: ['read'], expiresInSeconds: 3600 },
    });
    assert.equal(issued.statusCode, 201);
    const { id, token } = issued.json() as { id: string; token: string };
    const list = await server.app.inject({ method: 'GET', url: '/api/v1/device-tokens', headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.headers['cache-control'], 'no-store');
    assert.deepEqual(
      list.json().items.map((entry: { id: string }) => entry.id),
      [id],
    );
    assert.deepEqual(list.json().items[0].scopes, ['read']);
    assert.equal(list.body.includes(token), false);
    assert.equal(list.body.includes(hashToken(token)), false);
    assert.equal(/tokenHash|token_hash/.test(list.body), false);
    const otherList = await server.app.inject({
      method: 'GET',
      url: '/api/v1/device-tokens',
      headers: readerHeaders,
    });
    assert.deepEqual(otherList.json().items, []);
    const denied = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/device-tokens/${id}`,
      headers: readerHeaders,
    });
    assert.equal(denied.statusCode, 404);
    assert.equal(
      (await server.app.inject({ method: 'GET', url: '/api/v1/device-tokens' })).statusCode,
      401,
    );
    const deviceHeaders = { authorization: `Bearer ${token}` };
    assert.equal(
      (await server.app.inject({ method: 'GET', url: '/api/v1/libraries', headers: deviceHeaders }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await server.app.inject({
          method: 'GET',
          url: '/api/v1/device-tokens',
          headers: deviceHeaders,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/v1/device-tokens',
          headers: deviceHeaders,
          payload: { name: 'Escalation', scopes: ['admin'] },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await server.app.inject({ method: 'DELETE', url: `/api/v1/device-tokens/${id}`, headers }))
        .statusCode,
      204,
    );
    assert.equal(
      (await server.app.inject({ method: 'GET', url: '/api/v1/libraries', headers: deviceHeaders }))
        .statusCode,
      401,
    );
    const revoked = await server.app.inject({
      method: 'GET',
      url: '/api/v1/device-tokens',
      headers,
    });
    assert.ok(revoked.json().items[0].revokedAt);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
