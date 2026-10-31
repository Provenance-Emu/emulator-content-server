import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebPlayerDescriptor } from '@ecs/client';
import { startPlayer } from '../src/player/controller.js';
import { assetPlayHref } from '../src/player/links.js';
import { fixture } from './player-fixture.js';

const profile: WebPlayerDescriptor = {
  profileVersion: 1,
  id: 'org.example.handheld',
  name: 'Generated handheld',
  systems: ['com.provenance.gba'],
  runtime: 'emscripten-esm-v1',
  filesystem: 'memfs',
  threaded: false,
  saveCompletion: 'none',
  contentExtensions: ['gba'],
  maxContentBytes: 1024,
  buildVersion: 'generated-1',
  loader: {
    url: '/play/plugins/org.example.handheld/loader.js',
    sizeBytes: 24,
    sha256: 'a'.repeat(64),
  },
  wasm: {
    url: '/play/plugins/org.example.handheld/core.wasm',
    sizeBytes: 8,
    sha256: 'b'.repeat(64),
  },
  assets: [],
};
test('a compatible plugin provides a Play link with its public profile identifier', () => {
  const f = fixture();
  f.item.systemIdentifier = 'com.provenance.gba';
  const original = f.manifest.files[0];
  assert.ok(original);
  const rom = { ...original, relativePath: 'game.gba' };
  assert.equal(
    assetPlayHref([profile], f.item, rom),
    '/play/?item=item&asset=rom&profile=org.example.handheld',
  );
  assert.equal(
    assetPlayHref([profile], { ...f.item, systemIdentifier: 'com.provenance.nes' }, rom),
    null,
  );
});
test('async isolated runtime operations finish before main', async () => {
  const f = fixture();
  const writes: string[] = [];
  const original = f.runtime.FS.writeFile;
  f.runtime.FS.writeFile = async (path, bytes) => {
    await new Promise((r) => setTimeout(r, 1));
    original(path, bytes);
    writes.push(path);
  };
  f.runtime.callMain = () => {
    assert.ok(writes.includes('/ecs/content/game.nes'));
  };
  await startPlayer(
    f.client,
    { kind: 'asset', itemId: 'item', assetId: 'rom' },
    { canvas: {} as HTMLCanvasElement, importer: f.importer },
  );
});

test('browser accepts contract-valid mixed-case system IDs and profile limits', async () => {
  const { validateProfile } = await import('../src/player/runtime.js');
  assert.doesNotThrow(() =>
    validateProfile({
      ...profile,
      systems: Array.from({ length: 48 }, (_, i) => `com.example.System_${i}`),
      contentExtensions: Array.from({ length: 24 }, (_, i) => `extension${i}`),
      saveCompletion: 'command-reply-v1',
    }),
  );
});

test('plugin preserves the selected extension when several formats share one profile', async () => {
  const f = fixture();
  const resources = await f.client.playerCoreAssets(f.core.id);
  const { sha256Bytes } = await import('@ecs/client');
  const selected = {
    ...profile,
    contentExtensions: ['gb', 'gba'],
    loader: {
      ...profile.loader,
      sizeBytes: resources.loader.bytes.length,
      sha256: await sha256Bytes(resources.loader.bytes),
    },
    wasm: { ...profile.wasm, sha256: await sha256Bytes(resources.wasm.bytes) },
  };
  f.item.systemIdentifier = 'com.provenance.gba';
  const rom = f.manifest.files[0];
  assert.ok(rom);
  rom.relativePath = 'game.gba';
  f.client.playerProfile = async () => selected;
  f.client.playerProfileAssets = async () => ({ ...resources, assets: [] });
  let args: string[] = [];
  f.runtime.callMain = (value) => {
    args = value;
  };
  const session = await startPlayer(
    f.client,
    { kind: 'asset', itemId: 'item', assetId: 'rom' },
    { canvas: {} as HTMLCanvasElement, importer: f.importer, profileId: selected.id },
  );
  assert.ok(f.fs.has('/ecs/content/game.gba'));
  assert.ok(!f.fs.has('/ecs/content/game.gb'));
  assert.deepEqual(args, ['/ecs/content/game.gba']);
  assert.equal(session.saves, null);
});

test('plugin and legacy profile IDs retain separate default save paths', async () => {
  const { SaveSynchronizer } = await import('../src/player/saves.js');
  const { CommandChannel } = await import('../src/player/commands.js');
  const f = fixture();
  f.fs.set('/ecs/saves/game.srm', new Uint8Array([1, 2]));
  for (const profileId of ['org.example.player', 'org_example_player']) {
    const saves = new SaveSynchronizer(f.client, f.runtime, new CommandChannel(f.runtime), {
      libraryId: 'library',
      itemId: 'item',
      revision: 7,
      profileId,
    });
    await saves.capture('battery_save');
  }
  assert.notEqual(f.uploads[0]?.relativePath, f.uploads[1]?.relativePath);
});

test('a changed prepared profile or resource prevents importing any plugin code', async () => {
  const f = fixture();
  const resources = await f.client.playerCoreAssets(f.core.id);
  const { sha256Bytes } = await import('@ecs/client');
  const selected = {
    ...profile,
    loader: {
      ...profile.loader,
      sizeBytes: resources.loader.bytes.length,
      sha256: await sha256Bytes(resources.loader.bytes),
    },
    wasm: { ...profile.wasm, sha256: await sha256Bytes(resources.wasm.bytes) },
  };
  f.item.systemIdentifier = 'com.provenance.gba';
  const rom = f.manifest.files[0];
  assert.ok(rom);
  rom.relativePath = 'game.gba';
  f.client.playerProfile = async () => ({ ...selected, buildVersion: 'replaced' });
  f.client.playerProfileAssets = async () => ({ ...resources, assets: [] });
  await assert.rejects(
    startPlayer(
      f.client,
      { kind: 'asset', itemId: 'item', assetId: 'rom' },
      {
        canvas: {} as HTMLCanvasElement,
        importer: f.importer,
        profileId: selected.id,
        expectedProfile: selected,
      },
    ),
    /profile changed/i,
  );
  assert.equal(f.events.includes('import'), false);
  f.client.playerProfile = async () => selected;
  f.client.playerProfileAssets = async () => ({
    ...resources,
    loader: { ...resources.loader, bytes: new Uint8Array(resources.loader.bytes.length) },
    assets: [],
  });
  await assert.rejects(
    startPlayer(
      f.client,
      { kind: 'asset', itemId: 'item', assetId: 'rom' },
      { canvas: {} as HTMLCanvasElement, importer: f.importer, profileId: selected.id },
    ),
    /profile changed/i,
  );
  assert.equal(f.events.includes('import'), false);
  assert.equal(f.uploads.length, 0);
});

test('plugin-declared support-file folders stage BIOS resources under the system root', async () => {
  const f = fixture();
  const resources = await f.client.playerCoreAssets(f.core.id);
  const { sha256Bytes } = await import('@ecs/client');
  const bios = new Uint8Array([9, 8, 7]);
  const selected = {
    ...profile,
    systemFilesDirectory: 'neocd',
    loader: {
      ...profile.loader,
      sizeBytes: resources.loader.bytes.length,
      sha256: await sha256Bytes(resources.loader.bytes),
    },
    wasm: { ...profile.wasm, sha256: await sha256Bytes(resources.wasm.bytes) },
    assets: [
      {
        name: 'bios.rom',
        url: '/play/plugins/example/assets/bios.rom',
        sizeBytes: bios.length,
        sha256: await sha256Bytes(bios),
      },
    ],
  };
  f.item.systemIdentifier = 'com.provenance.gba';
  const rom = f.manifest.files[0];
  assert.ok(rom);
  rom.relativePath = 'game.gba';
  f.client.playerProfile = async () => selected;
  f.client.playerProfileAssets = async () => ({
    ...resources,
    assets: [{ name: 'bios.rom', bytes: bios }],
  });
  const session = await startPlayer(
    f.client,
    { kind: 'asset', itemId: 'item', assetId: 'rom' },
    { canvas: {} as HTMLCanvasElement, importer: f.importer, profileId: selected.id },
  );
  assert.deepEqual(f.fs.get('/ecs/system/neocd/bios.rom'), bios);
  assert.equal(f.fs.has('/ecs/system/bios.rom'), false);
  const { profileIdentity, validateProfile } = await import('../src/player/runtime.js');
  assert.notEqual(
    profileIdentity(selected),
    profileIdentity({ ...selected, systemFilesDirectory: 'other' }),
  );
  assert.throws(() => validateProfile({ ...selected, systemFilesDirectory: '../outside' }));
  session.releaseLoader();
});
