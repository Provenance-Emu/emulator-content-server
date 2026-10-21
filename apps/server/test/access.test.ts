import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

test('local network syncs without a password and only this machine edits accounts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-access-'));
  const server = await openServer({ dataDir: dir, loginLimit: 20 });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    assert.equal(created.statusCode, 201);
    const ownerToken = (created.json() as { token: string }).token;

    const here = await server.app.inject({ method: 'GET', url: '/api/v1/access' });
    assert.equal(here.statusCode, 200);
    assert.deepEqual(here.json(), {
      mode: 'lan',
      subnets: [],
      applies: true,
      trusted: true,
      manages: true,
    });

    const phone = await server.app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      remoteAddress: '192.168.1.20',
    });
    assert.equal(phone.statusCode, 200);
    assert.equal((phone.json() as { items: unknown[] }).items.length, 1);

    const phoneAccounts = await server.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      remoteAddress: '192.168.1.20',
    });
    assert.equal(phoneAccounts.statusCode, 403);

    const away = await server.app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      remoteAddress: '8.8.8.8',
    });
    assert.equal(away.statusCode, 401);

    const accounts = await server.app.inject({ method: 'GET', url: '/api/v1/users' });
    assert.equal(accounts.statusCode, 200);
    assert.equal(JSON.stringify(accounts.json()).includes('password'), false);

    const added = await server.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      payload: { username: 'player', password: 'battery-staple' },
    });
    assert.equal(added.statusCode, 201);
    const playerId = (added.json() as { id: string }).id;
    const signedIn = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '8.8.8.8',
      payload: { username: 'player', password: 'battery-staple' },
    });
    assert.equal(signedIn.statusCode, 200);
    const playerToken = (signedIn.json() as { token: string }).token;

    const reset = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${playerId}`,
      payload: { password: 'new-battery-staple' },
    });
    assert.equal(reset.statusCode, 204);
    assert.equal(server.catalog.auditContains('set-password', 'new-battery-staple'), false);
    const stale = await server.app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: { authorization: `Bearer ${playerToken}` },
      remoteAddress: '8.8.8.8',
    });
    assert.equal(stale.statusCode, 401);
    const fresh = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '8.8.8.8',
      payload: { username: 'player', password: 'new-battery-staple' },
    });
    assert.equal(fresh.statusCode, 200);

    const libraryId = (phone.json() as { items: Array<{ id: string }> }).items[0]?.id;
    assert.ok(libraryId);
    const guest = await server.app.inject({
      method: 'POST',
      url: '/api/v1/guest-grants',
      payload: { libraryId, capabilities: ['read'], expiresInSeconds: 3600 },
    });
    assert.equal(guest.statusCode, 201);
    const guestToken = (guest.json() as { token: string }).token;
    assert.ok(guestToken.length > 10);
    const listed = await server.app.inject({ method: 'GET', url: '/api/v1/guest-grants' });
    assert.equal(listed.statusCode, 200);
    assert.equal(JSON.stringify(listed.json()).includes(guestToken), false);
    assert.equal(server.catalog.auditContains('create-guest-grant', guestToken), false);

    const refused = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/access',
      remoteAddress: '192.168.1.20',
      payload: { mode: 'token', subnets: [] },
    });
    assert.equal(refused.statusCode, 403);
    const world = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/access',
      payload: { mode: 'subnets', subnets: ['0.0.0.0/0'] },
    });
    assert.equal(world.statusCode, 400);
    const chosen = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/access',
      payload: { mode: 'subnets', subnets: ['203.0.113.50/24'] },
    });
    assert.equal(chosen.statusCode, 200);
    assert.deepEqual((chosen.json() as { subnets: string[] }).subnets, ['203.0.113.0/24']);
    const visitor = await server.app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      remoteAddress: '203.0.113.9',
    });
    assert.equal(visitor.statusCode, 200);
    const neighbor = await server.app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      remoteAddress: '192.168.1.20',
    });
    assert.equal(neighbor.statusCode, 401);

    const locked = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/access',
      headers: { authorization: `Bearer ${ownerToken}` },
      remoteAddress: '8.8.8.8',
      payload: { mode: 'token', subnets: [] },
    });
    assert.equal(locked.statusCode, 200);
    const after = await server.app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      remoteAddress: '203.0.113.9',
    });
    assert.equal(after.statusCode, 401);

    const tray = await server.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/access',
      headers: { origin: 'http://localhost:5174', 'access-control-request-method': 'GET' },
    });
    assert.equal(tray.statusCode, 204);
    assert.equal(tray.headers['access-control-allow-origin'], 'http://localhost:5174');
    const website = await server.app.inject({
      method: 'GET',
      url: '/api/v1/access',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(website.headers['access-control-allow-origin'], undefined);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a public server does not treat the proxy address as the owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-public-'));
  const server = await openServer({ dataDir: dir, localTrust: false });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    assert.equal(created.statusCode, 201);
    const libraries = await server.app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(libraries.statusCode, 401);
    const access = await server.app.inject({ method: 'GET', url: '/api/v1/access' });
    assert.equal((access.json() as { applies: boolean }).applies, false);
    assert.equal((access.json() as { manages: boolean }).manages, false);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('approved tray origins expose resume validators and allow chunk/revision headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-tray-cors-'));
  const server = await openServer({ dataDir: dir, localTrust: false });
  try {
    for (const origin of [
      'tauri://localhost',
      'http://tauri.localhost',
      'https://tauri.localhost',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    ]) {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/v1/capabilities',
        headers: { origin },
      });
      assert.equal(response.headers['access-control-allow-origin'], origin);
      assert.equal(response.headers['access-control-expose-headers'], 'etag, content-range');
      const preflight = await server.app.inject({
        method: 'OPTIONS',
        url: '/api/v1/uploads/test',
        headers: {
          origin,
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'authorization, content-range, if-match',
        },
      });
      assert.equal(preflight.statusCode, 204);
      assert.ok(
        String(preflight.headers['access-control-allow-headers'])
          .split(', ')
          .includes('content-range'),
      );
      assert.ok(
        String(preflight.headers['access-control-allow-headers']).split(', ').includes('if-match'),
      );
    }
    for (const origin of [
      'https://evil.example',
      'https://tauri.localhost.evil.example',
      'tauri://evil.example',
      'https://tauri.localhost:444',
      'ftp://tauri.localhost',
      'http://localhost:5175',
    ]) {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/v1/capabilities',
        headers: { origin },
      });
      assert.equal(response.headers['access-control-allow-origin'], undefined, origin);
      assert.equal(response.headers['access-control-expose-headers'], undefined, origin);
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
