import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';
import { createPlayerCatalogSnapshot } from '../src/player-catalog-snapshot.js';
import { upstreamFixture } from './player-cache-fixture.js';

test('catalog revisions leave installed versions pinned and an older selection can reinstall offline', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-player-catalog-selection-'));
  let server: Awaited<ReturnType<typeof openServer>> | undefined;
  t.after(async () => {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const dataDir = join(directory, 'data');
  const a = upstreamFixture();
  const b = upstreamFixture(2);
  const selected = [];
  for (const [name, fixture] of [
    ['a', a],
    ['b', b],
  ] as const) {
    const snapshot = createPlayerCatalogSnapshot([fixture.entry]);
    const file = join(directory, `${name}.json`);
    await writeFile(file, JSON.stringify(snapshot));
    selected.push({ file, id: snapshot.id });
  }
  const firstSelection = selected[0];
  const nextSelection = selected[1];
  assert.ok(firstSelection && nextSelection);
  let current = a;
  let offline = false;
  const network = t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (offline) throw new Error('generated unavailable upstream');
    return new Response(url.endsWith('.wasm') ? current.wasm : current.loader);
  });
  server = await openServer({ dataDir, playerCatalogSnapshot: firstSelection });
  const token = issueToken();
  server.catalog.saveBootstrapHash(token.hash);
  const bootstrap = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: token.token, username: 'owner', password: 'generated-password' },
  });
  assert.equal(bootstrap.statusCode, 201);
  const headers = { authorization: `Bearer ${bootstrap.json().token}` };
  const base = '/api/v1/player/management';
  const install = `${base}/install/${a.entry.id}`;
  assert.equal(
    (await server.app.inject({ method: 'POST', url: install, headers })).statusCode,
    200,
  );
  assert.equal(
    (
      await server.app.inject({
        method: 'PUT',
        url: `${base}/${a.entry.id}/system/generated.bin`,
        headers: { ...headers, 'content-type': 'application/vnd.ecs.player-system-file' },
        payload: Buffer.from([1, 2]),
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await server.app.inject({
        method: 'PATCH',
        url: `${base}/${a.entry.id}`,
        headers,
        payload: { enabled: false },
      })
    ).statusCode,
    200,
  );
  await server.close();
  current = b;
  server = await openServer({ dataDir, playerCatalogSnapshot: nextSelection });
  const unchanged = (await server.app.inject({ url: base, headers })).json().items[0];
  assert.equal(unchanged.profile.buildVersion, 'generated-1');
  assert.equal(unchanged.enabled, false);
  assert.ok(
    unchanged.profile.assets.some((asset: { name: string }) => asset.name === 'generated.bin'),
  );
  assert.equal(
    (await server.app.inject({ method: 'DELETE', url: `${base}/${a.entry.id}`, headers }))
      .statusCode,
    200,
  );
  assert.equal(
    (await server.app.inject({ method: 'POST', url: install, headers })).statusCode,
    200,
  );
  assert.equal(
    (await server.app.inject({ url: base, headers })).json().items[0].profile.buildVersion,
    'generated-2',
  );
  await server.close();
  offline = true;
  const fetched = network.mock.callCount();
  server = await openServer({ dataDir, playerCatalogSnapshot: firstSelection });
  assert.equal(
    (await server.app.inject({ url: base, headers })).json().items[0].profile.buildVersion,
    'generated-2',
  );
  assert.equal(
    (await server.app.inject({ method: 'DELETE', url: `${base}/${a.entry.id}`, headers }))
      .statusCode,
    200,
  );
  assert.equal(
    (await server.app.inject({ method: 'POST', url: install, headers })).statusCode,
    200,
  );
  assert.equal(network.mock.callCount(), fetched);
  assert.deepEqual(
    (await server.app.inject({ url: `/play/plugins/${a.entry.id}/loader.js`, headers })).rawPayload,
    a.loader,
  );
});

test('invalid operator pin fails before creating the server data directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-player-catalog-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot = createPlayerCatalogSnapshot([upstreamFixture().entry]);
  const file = join(directory, 'catalog.json');
  await writeFile(file, JSON.stringify(snapshot));
  const dataDir = join(directory, 'not-created');
  await assert.rejects(
    openServer({ dataDir, playerCatalogSnapshot: { file, id: '0'.repeat(64) } }),
    /snapshot/i,
  );
  await assert.rejects(lstat(dataDir), { code: 'ENOENT' });
});
