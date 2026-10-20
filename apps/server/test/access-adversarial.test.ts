import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-access-adversarial-'));
  let server: Awaited<ReturnType<typeof openServer>> | undefined;
  t.after(async () => {
    try {
      await server?.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  server = await openServer({ dataDir: dir, localTrust: false });
  const bootstrap = issueToken();
  server.catalog.saveBootstrapHash(bootstrap.hash);
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
  });
  assert.equal(response.statusCode, 201);
  const owner = { authorization: `Bearer ${response.json().token}` };
  const libraries = await server.app.inject({ url: '/api/v1/libraries', headers: owner });
  assert.equal(libraries.statusCode, 200);
  const libraryId = libraries.json().items[0].id as string;
  return { ...server, owner, libraryId };
}

test('deleting a nonexistent guest grant returns 404 and preserves existing grants', async (t) => {
  const { app, owner, libraryId } = await setup(t);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/guest-grants',
    headers: owner,
    payload: { libraryId, capabilities: ['read'], expiresInSeconds: 3600 },
  });
  assert.equal(created.statusCode, 201);
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/v1/guest-grants/${randomUUID()}`,
    headers: owner,
  });
  assert.equal(removed.statusCode, 404, removed.body);
  assert.equal(removed.json().type, 'urn:ecs:problem:not-found');
  const stillValid = await app.inject({
    url: '/api/v1/libraries',
    headers: { authorization: `Bearer ${created.json().token}` },
  });
  assert.equal(stillValid.statusCode, 200);
});

for (const kind of ['guest', 'device'] as const) {
  test(`a revoked ${kind} token cannot be replayed`, async (t) => {
    const { app, owner, libraryId } = await setup(t);
    const route = kind === 'guest' ? '/api/v1/guest-grants' : '/api/v1/device-tokens';
    const created = await app.inject({
      method: 'POST',
      url: route,
      headers: owner,
      payload:
        kind === 'guest'
          ? { libraryId, capabilities: ['read'], expiresInSeconds: 3600 }
          : { name: 'read-only device', scopes: ['read'] },
    });
    assert.equal(created.statusCode, 201);
    const credential = created.json() as { id: string; token: string };
    const headers = { authorization: `Bearer ${credential.token}` };
    assert.equal((await app.inject({ url: '/api/v1/libraries', headers })).statusCode, 200);
    const revoked = await app.inject({
      method: 'DELETE',
      url: `${route}/${credential.id}`,
      headers: owner,
    });
    assert.equal(revoked.statusCode, 204);
    for (let attempt = 0; attempt < 2; attempt++) {
      const replay = await app.inject({ url: '/api/v1/libraries', headers });
      assert.equal(replay.statusCode, 401);
      assert.equal(replay.json().type, 'urn:ecs:problem:unauthorized');
    }
    assert.equal((await app.inject({ url: '/api/v1/libraries', headers: owner })).statusCode, 200);
  });
}

test('a guest grant stops working at its exact expiration time', async (t) => {
  const { app, owner, libraryId } = await setup(t);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/guest-grants',
    headers: owner,
    payload: { libraryId, capabilities: ['read'], expiresInSeconds: 60 },
  });
  assert.equal(created.statusCode, 201);
  const credential = created.json() as { token: string; expiresAt: string };
  const headers = { authorization: `Bearer ${credential.token}` };
  const expires = Date.parse(credential.expiresAt);
  t.mock.timers.enable({ apis: ['Date'], now: expires - 1 });
  assert.equal((await app.inject({ url: '/api/v1/libraries', headers })).statusCode, 200);
  t.mock.timers.setTime(expires);
  const expired = await app.inject({ url: '/api/v1/libraries', headers });
  assert.equal(expired.statusCode, 401);
  assert.equal(expired.json().type, 'urn:ecs:problem:unauthorized');
  assert.equal((await app.inject({ url: '/api/v1/libraries', headers: owner })).statusCode, 200);
});

test('a library reader cannot promote itself or administer guest grants', async (t) => {
  const { app, owner, libraryId } = await setup(t);
  const user = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: owner,
    payload: { username: 'reader', password: 'correct-horse' },
  });
  assert.equal(user.statusCode, 201);
  const membership = `/api/v1/libraries/${libraryId}/members/${user.json().id}`;
  const assigned = await app.inject({
    method: 'PUT',
    url: membership,
    headers: owner,
    payload: { role: 'reader' },
  });
  assert.equal(assigned.statusCode, 204);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'reader', password: 'correct-horse' },
  });
  assert.equal(login.statusCode, 200);
  const headers = { authorization: `Bearer ${login.json().token}` };
  const visible = await app.inject({ url: '/api/v1/libraries', headers });
  assert.equal(visible.statusCode, 200);
  assert.equal(
    visible.json().items.some((item: { id: string }) => item.id === libraryId),
    true,
  );
  const promoted = await app.inject({
    method: 'PUT',
    url: membership,
    headers,
    payload: { role: 'owner' },
  });
  assert.equal(promoted.statusCode, 403);
  assert.equal(promoted.json().type, 'urn:ecs:problem:forbidden');
  const grant = await app.inject({
    method: 'POST',
    url: '/api/v1/guest-grants',
    headers,
    payload: {
      libraryId,
      capabilities: ['read', 'write', 'share_restricted'],
      expiresInSeconds: 3600,
    },
  });
  assert.equal(grant.statusCode, 403);
  assert.equal(grant.json().type, 'urn:ecs:problem:forbidden');
  const write = await app.inject({
    method: 'POST',
    url: '/api/v1/items',
    headers,
    payload: { libraryId, systemIdentifier: 'com.provenance.nes', title: 'Forbidden write' },
  });
  assert.equal(write.statusCode, 403);
  const grants = await app.inject({ url: '/api/v1/guest-grants', headers: owner });
  assert.equal(grants.statusCode, 200);
  assert.deepEqual(grants.json().items, []);
  const shared = await app.inject({
    method: 'POST',
    url: '/api/v1/guest-grants',
    headers: owner,
    payload: { libraryId, capabilities: ['read'], expiresInSeconds: 3600 },
  });
  assert.equal(shared.statusCode, 201);
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/v1/guest-grants/${shared.json().id}`,
    headers,
  });
  assert.equal(removed.statusCode, 403);
  assert.equal(removed.json().type, 'urn:ecs:problem:forbidden');
  const stillValid = await app.inject({
    url: '/api/v1/libraries',
    headers: { authorization: `Bearer ${shared.json().token}` },
  });
  assert.equal(stillValid.statusCode, 200);
  const promotedByOwner = await app.inject({
    method: 'PUT',
    url: membership,
    headers: owner,
    payload: { role: 'owner' },
  });
  assert.equal(promotedByOwner.statusCode, 204);
  const revokedByLibraryOwner = await app.inject({
    method: 'DELETE',
    url: `/api/v1/guest-grants/${shared.json().id}`,
    headers,
  });
  assert.equal(revokedByLibraryOwner.statusCode, 204);
  const replay = await app.inject({
    url: '/api/v1/libraries',
    headers: { authorization: `Bearer ${shared.json().token}` },
  });
  assert.equal(replay.statusCode, 401);
});
