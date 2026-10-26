import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

test('membership listing requires library administration and returns only safe access metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-members-'));
  const server = await openServer({ dataDir: directory, localTrust: false });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'generated-password' },
    });
    const { userId, token } = created.json() as { userId: string; token: string };
    const headers = { authorization: `Bearer ${token}` };
    const library = server.catalog.createLibrary(userId, 'Shared');
    const otherLibrary = server.catalog.createLibrary(userId, 'Private');
    const account = await server.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers,
      payload: { username: 'member', password: 'generated-password' },
    });
    const memberId = account.json().id as string;
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'member', password: 'generated-password' },
    });
    const memberHeaders = { authorization: `Bearer ${login.json().token}` };
    server.catalog.setMember(library.id, memberId, 'reader', userId);
    const url = `/api/v1/libraries/${library.id}/members`;
    const listed = await server.app.inject({ method: 'GET', url, headers });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.headers['cache-control'], 'no-store');
    assert.deepEqual(
      listed.json().items.find((entry: { userId: string }) => entry.userId === memberId),
      { userId: memberId, role: 'reader' },
    );
    for (const entry of listed.json().items)
      assert.deepEqual(Object.keys(entry).sort(), ['role', 'userId']);
    assert.equal(
      (await server.app.inject({ method: 'GET', url, headers: memberHeaders })).statusCode,
      403,
    );
    assert.equal((await server.app.inject({ method: 'GET', url })).statusCode, 401);
    server.catalog.setMember(library.id, memberId, 'owner', userId);
    assert.equal(
      (await server.app.inject({ method: 'GET', url, headers: memberHeaders })).statusCode,
      200,
    );
    assert.equal(
      (
        await server.app.inject({
          method: 'GET',
          url: `/api/v1/libraries/${otherLibrary.id}/members`,
          headers: memberHeaders,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await server.app.inject({
          method: 'GET',
          url: '/api/v1/libraries/missing/members',
          headers,
        })
      ).statusCode,
      404,
    );
    server.catalog.removeMember(library.id, memberId, userId);
    const removed = await server.app.inject({ method: 'GET', url, headers });
    assert.equal(
      removed.json().items.some((entry: { userId: string }) => entry.userId === memberId),
      false,
    );
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
