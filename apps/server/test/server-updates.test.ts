import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import type { ServerUpdateStatus } from '@ecs/protocol';
import { openServer } from '../src/index.js';

test('update actions require an owner session and validate the selected mode and build', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-update-auth-'));
  const status: ServerUpdateStatus = {
    supported: true,
    phase: 'idle',
    prompt: false,
    settings: { channel: 'nightly', mode: 'off' },
  };
  let decisions = 0;
  const server = await openServer({
    dataDir: directory,
    updates: {
      status: () => status,
      configure: async (settings) => ({ ...status, settings }),
      decide: async () => {
        decisions++;
        return status;
      },
    },
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const bootstrap = issueToken();
  server.catalog.saveBootstrapHash(bootstrap.hash);
  const session = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
  });
  assert.equal(session.statusCode, 201);
  const owner = { authorization: `Bearer ${session.json().token}` };
  const device = await server.app.inject({
    method: 'POST',
    url: '/api/v1/device-tokens',
    headers: owner,
    payload: { name: 'Device', scopes: ['admin'] },
  });
  assert.equal(device.statusCode, 201);
  const url = '/api/v1/server/updates';
  const decision = { action: 'install', buildId: 'a'.repeat(64) };
  const unauthorized = await server.app.inject({ method: 'POST', url, payload: decision });
  assert.ok([401, 403].includes(unauthorized.statusCode), unauthorized.body);
  const fromDevice = await server.app.inject({
    method: 'POST',
    url,
    payload: decision,
    headers: { authorization: `Bearer ${device.json().token}` },
  });
  assert.equal(fromDevice.statusCode, 403);
  assert.equal(
    (
      await server.app.inject({
        method: 'POST',
        url,
        headers: owner,
        payload: { action: 'install', buildId: 'old' },
      })
    ).statusCode,
    400,
  );
  const changed = await server.app.inject({
    method: 'PUT',
    url,
    headers: owner,
    payload: { channel: 'nightly', mode: 'automatic' },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().settings.mode, 'automatic');
  assert.equal(
    (await server.app.inject({ method: 'POST', url, headers: owner, payload: decision }))
      .statusCode,
    200,
  );
  assert.equal(decisions, 1);
});
