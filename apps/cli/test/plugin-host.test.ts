import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer, type PluginManagementBridge } from '@ecs/server';
import { ManagedPluginHost } from '../src/plugin-host.js';

test('web plugin management installs, enrolls, disables and resumes a separate private host', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-managed-plugin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let host: ManagedPluginHost;
  const bridge: PluginManagementBridge = {
    view: () => host.view(),
    installDefaults: () => host.installDefaults(),
    configure: (configuration) => host.configure(configuration),
    connect: (id, token) => host.connect(id, token),
    doctor: () => host.doctor(),
  };
  const server = await openServer({ dataDir: join(directory, 'data'), pluginManagement: bridge });
  t.after(async () => {
    await host?.close();
    await server.close();
  });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = server.app.server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  host = new ManagedPluginHost(join(directory, 'plugins'), url);

  const bootstrap = issueToken();
  server.catalog.saveBootstrapHash(bootstrap.hash);
  const session = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: bootstrap.token, username: 'owner', password: 'generated-password' },
  });
  assert.equal(session.statusCode, 201);
  const headers = { authorization: `Bearer ${session.json().token}` };
  for (const [method, path] of [
    ['GET', ''],
    ['POST', '/defaults'],
    ['POST', '/doctor'],
    ['PATCH', ''],
  ] as const) {
    const denied = await server.app.inject({
      method,
      url: '/api/v1/plugins' + path,
      ...(method === 'PATCH' ? { payload: {} } : {}),
    });
    assert.equal(denied.statusCode, 403, 'trusted local access cannot install native code');
  }
  const before = await server.app.inject({ url: '/api/v1/plugins', headers });
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json().items.length, 0);
  const install = await server.app.inject({
    method: 'POST',
    url: '/api/v1/plugins/defaults',
    headers,
  });
  assert.equal(install.statusCode, 200, install.body);
  const view = install.json();
  assert.equal(view.items[0].id, 'org.ecs.library-cleanup');
  assert.equal(view.items[0].enabled, true);
  assert.equal(view.running, true);
  assert.ok(view.hostId);
  assert.equal(server.catalog.workflowIdentities.listHosts().length, 1);
  const config = JSON.parse(await readFile(join(directory, 'plugins/connection.json'), 'utf8'));
  assert.equal(install.body.includes(config.token), false);
  const scoped = await server.app.inject({
    url: '/api/v1/plugins',
    headers: { authorization: `Bearer ${config.token}` },
  });
  assert.equal(scoped.statusCode, 401, 'host credentials cannot manage native software');
  if (process.platform !== 'win32')
    assert.equal((await stat(join(directory, 'plugins/connection.json'))).mode & 0o077, 0);
  assert.equal(server.catalog.workflowIdentities.authenticateHost(issueToken().hash), null);
  const duplicate = await server.app.inject({
    method: 'POST',
    url: '/api/v1/plugins/defaults',
    headers,
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(duplicate.json().hostId, view.hostId);
  assert.equal(duplicate.json().items.length, 1);
  const patch = { id: view.items[0].id, digest: view.items[0].digest, enabled: false };
  const disabled = await server.app.inject({
    method: 'PATCH',
    url: '/api/v1/plugins',
    headers,
    payload: patch,
  });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().items[0].enabled, false);
  assert.equal(disabled.json().running, false);
  assert.deepEqual(server.catalog.workflowIdentities.getHost(view.hostId)?.packages, []);
  const invalid = await server.app.inject({
    method: 'PATCH',
    url: '/api/v1/plugins',
    headers,
    payload: { ...patch, path: '/tmp/untrusted.js' },
  });
  assert.equal(invalid.statusCode, 400);
  const enabled = await server.app.inject({
    method: 'PATCH',
    url: '/api/v1/plugins',
    headers,
    payload: { ...patch, enabled: true },
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  await host.close();
  host = new ManagedPluginHost(join(directory, 'plugins'), url);
  const resumed = await host.view();
  assert.equal(resumed.hostId, view.hostId);
  assert.equal(resumed.running, true);
  assert.equal(resumed.items[0]?.enabled, true);
  const owner = server.catalog.listUsers().find((user) => user.isOwner);
  assert.ok(owner);
  server.catalog.workflowIdentities.revokeHost(view.hostId, owner.id);
  const repaired = await server.app.inject({
    method: 'POST',
    url: '/api/v1/plugins/doctor',
    headers,
  });
  assert.equal(repaired.statusCode, 200, repaired.body);
  assert.notEqual(repaired.json().hostId, view.hostId);
  assert.equal(repaired.json().running, true);
});
