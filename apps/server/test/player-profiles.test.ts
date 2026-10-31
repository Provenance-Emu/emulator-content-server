import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';
import type { PlayerAssets } from '../src/player-assets.js';
import { loadPlayerProfiles } from '../src/player-profiles.js';

const loader = 'export default async () => ({ FS: {} });';
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const support = Buffer.from('generated test bytes');
const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
function manifest(id = 'org.example.player') {
  return {
    id,
    name: 'Test player',
    kind: 'player',
    version: '1',
    engine: 'ecs.plugin/1',
    apps: ['org.example.app'],
    player: {
      systems: ['com.provenance.nes', 'com.provenance.snes'],
      module: 'core.wasm',
      web: {
        profileVersion: 1,
        runtime: 'emscripten-esm-v1',
        filesystem: 'memfs',
        threaded: false,
        saveCompletion: 'none',
        contentExtensions: ['nes', 'sfc'],
        maxContentBytes: 1024,
        buildVersion: 'fixture-1',
        loader: { file: 'loader.js', sha256: sha(loader) },
        wasm: { file: 'core.wasm', sha256: sha(wasm) },
        assets: [{ name: 'support.data', file: 'support.data', sha256: sha(support) }],
      },
    },
  };
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-web-profiles-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = join(dir, 'players');
  await mkdir(registry);
  const install = async (name: string, m = manifest()) => {
    const plugin = join(registry, name);
    await mkdir(plugin);
    await writeFile(join(plugin, 'plugin.json'), JSON.stringify(m));
    await writeFile(join(plugin, 'loader.js'), loader);
    await writeFile(join(plugin, 'core.wasm'), wasm);
    await writeFile(join(plugin, 'support.data'), support);
    return plugin;
  };
  return { dir, registry, install };
}
test('multiple player profiles serve only snapshotted declared resources with read permission', async (t) => {
  const f = await fixture(t);
  const plugin = await f.install('a');
  await f.install('b', manifest('org.example.second'));
  const server = await openServer({ dataDir: join(f.dir, 'data'), playerPluginsDir: f.registry });
  t.after(() => server.close());
  const token = issueToken();
  server.catalog.saveBootstrapHash(token.hash);
  const bootstrapped = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: token.token, username: 'owner', password: 'fixture-password' },
  });
  assert.equal(bootstrapped.statusCode, 201);
  assert.equal(
    (await server.app.inject({ url: '/api/v1/capabilities' })).json().features.webPlayback,
    true,
  );
  const catalog = await server.app.inject({ url: '/api/v1/player/profiles' });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().items.length, 2);
  assert.equal(catalog.json().defaultProfileId, 'org.example.player');
  assert.equal(catalog.body.includes(f.dir), false);
  await rm(join(plugin, 'core.wasm'));
  await writeFile(join(plugin, 'loader.js'), 'changed');
  const paths = [
    '/api/v1/player/profiles',
    '/api/v1/player/profiles/org.example.player',
    '/play/plugins/org.example.player/loader.js',
    '/play/plugins/org.example.player/core.wasm',
    '/play/plugins/org.example.player/assets/support.data',
  ];
  for (const url of paths) {
    const allowed = await server.app.inject({ url });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.headers['cache-control'], 'private, no-store');
    assert.equal((await server.app.inject({ url, remoteAddress: '203.0.113.5' })).statusCode, 401);
    assert.equal(
      (
        await server.app.inject({
          url: `${url}?token=not-a-credential`,
          remoteAddress: '203.0.113.5',
        })
      ).statusCode,
      401,
    );
  }
  assert.equal((await server.app.inject({ url: paths[2] })).body, loader);
  assert.deepEqual((await server.app.inject({ url: paths[3] })).rawPayload, wasm);
  assert.deepEqual((await server.app.inject({ url: paths[4] })).rawPayload, support);
  for (const url of [
    '/play/plugins/org.example.player/plugin.json',
    '/play/plugins/org.example.player/assets/plugin.json',
    '/play/plugins/org.example.player/assets/..%2Fplugin.json',
    '/play/plugins/missing/core.wasm',
  ])
    assert.equal((await server.app.inject({ url })).statusCode, 404);
});

test('declared startup defaults survive the manifest to HTTP descriptor boundary', async (t) => {
  const f = await fixture(t);
  const m = manifest();
  await f.install('defaults', {
    ...m,
    player: {
      ...m.player,
      web: {
        ...m.player.web,
        runtime: 'retroarch-emscripten-esm',
        defaultCoreOptions: { atari800_system: '5200' },
      },
    },
  } as ReturnType<typeof manifest>);
  const server = await openServer({
    dataDir: join(f.dir, 'data'),
    playerPluginsDir: f.registry,
  });
  t.after(() => server.close());
  const token = issueToken();
  server.catalog.saveBootstrapHash(token.hash);
  const bootstrapped = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: token.token, username: 'owner', password: 'fixture-password' },
  });
  assert.equal(bootstrapped.statusCode, 201);
  const response = await server.app.inject({ url: '/api/v1/player/profiles/org.example.player' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().defaultCoreOptions, { atari800_system: '5200' });
});
test('legacy profile stays the default alongside sorted installed plugin profiles', async (t) => {
  const f = await fixture(t);
  await f.install('z', manifest('org.example.alpha'));
  await f.install('a', manifest('org.example.zeta'));
  const resource = (file: string, bytes: string | Buffer) => ({
    url: `/play/cores/zlegacy/${file}`,
    sha256: sha(bytes),
    sizeBytes: Buffer.byteLength(bytes),
  });
  const legacy: PlayerAssets = {
    loader: Buffer.from(loader),
    wasm,
    descriptor: {
      version: 1,
      id: 'zlegacy',
      name: 'Legacy',
      systems: ['com.provenance.nes'],
      runtime: 'retroarch-emscripten-esm',
      threaded: false,
      filesystem: 'memfs',
      saveCompletion: 'command-reply-v1',
      frontendCommit: 'a'.repeat(40),
      coreCommit: 'b'.repeat(40),
      emscriptenVersion: '3.1.46',
      contentExtension: 'nes',
      maxContentBytes: 1024,
      loader: resource('loader.js', loader),
      wasm: resource('core.wasm', wasm),
    },
  };
  const profiles = await loadPlayerProfiles(f.registry, legacy);
  assert.equal(profiles.defaultProfileId, 'zlegacy');
  assert.deepEqual(
    [...profiles.items.keys()],
    ['org.example.alpha', 'org.example.zeta', 'zlegacy'],
  );
});

test('empty profile catalog is explicit', async () => {
  const p = await loadPlayerProfiles();
  assert.equal(p.items.size, 0);
  assert.equal(p.defaultProfileId, null);
});
for (const mode of [
  'hash',
  'file-symlink',
  'dir-symlink',
  'registry-symlink',
  'oversize',
  'wasm-oversize',
  'asset-oversize',
  'duplicate',
  'too-many',
  'manifest-symlink',
] as const) {
  test(`startup rejects ${mode} without leaking operator paths`, async (t) => {
    const f = await fixture(t);
    const plugin = await f.install('a');
    let registry = f.registry;
    if (mode === 'hash') await writeFile(join(plugin, 'loader.js'), 'changed');
    if (mode === 'oversize') await truncate(join(plugin, 'loader.js'), 8388609);
    if (mode === 'wasm-oversize') await truncate(join(plugin, 'core.wasm'), 67108865);
    if (mode === 'asset-oversize') await truncate(join(plugin, 'support.data'), 33554433);
    if (mode === 'duplicate') await f.install('b');
    if (mode === 'too-many')
      for (let i = 0; i < 64; i++) await f.install(`extra${i}`, manifest(`org.example.p${i}`));
    if (mode === 'dir-symlink') await symlink(plugin, join(registry, 'link'));
    if (mode === 'registry-symlink') {
      registry = join(f.dir, 'link');
      await symlink(f.registry, registry);
    }
    if (mode === 'file-symlink' || mode === 'manifest-symlink') {
      const name = mode === 'file-symlink' ? 'loader.js' : 'plugin.json';
      await rm(join(plugin, name));
      const external = join(f.dir, name);
      await writeFile(external, name === 'loader.js' ? loader : JSON.stringify(manifest()));
      await symlink(external, join(plugin, name));
    }
    await assert.rejects(
      loadPlayerProfiles(registry),
      (e: Error) => /Invalid player plugin/.test(e.message) && !e.message.includes(f.dir),
    );
  });
}

test('a broad software-core registry can contain 64 profiles', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 64; i++) await f.install(`core${i}`, manifest(`org.example.core${i}`));
  assert.equal((await loadPlayerProfiles(f.registry)).items.size, 64);
});
