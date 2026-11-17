import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Bytes, type WebPlayerDescriptor } from '@ecs/client';
import { startPlayer } from '../src/player/controller.js';
import { assetPlayHref, sourcePlayHref } from '../src/player/links.js';
import { fixture } from './player-fixture.js';

async function cueFixture() {
  const f = fixture();
  const resources = await f.client.playerCoreAssets(f.core.id);
  const profile: WebPlayerDescriptor = {
    profileVersion: 1,
    id: 'test.cue',
    name: 'Generated CUE player',
    systems: f.core.systems,
    runtime: 'retroarch-emscripten-esm',
    filesystem: 'memfs',
    threaded: false,
    saveCompletion: 'none',
    contentExtensions: ['cue'],
    maxContentBytes: 1024,
    buildVersion: 'Generated fixture',
    loader: { ...f.core.loader, sha256: await sha256Bytes(resources.loader.bytes) },
    wasm: { ...f.core.wasm, sha256: await sha256Bytes(resources.wasm.bytes) },
    assets: [],
  };
  const descriptor = new TextEncoder().encode(
    'FILE "../tracks/one.bin" BINARY\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nFILE "../tracks/two.bin" BINARY\nTRACK 02 AUDIO\nINDEX 01 00:00:00\n',
  );
  const original = f.manifest.files[0];
  assert.ok(original);
  f.manifest.files = [
    { ...original, id: 'rom', relativePath: 'disc/original.cue', size: descriptor.length },
    { ...original, id: 'one', relativePath: 'tracks/one.bin', size: 3 },
    { ...original, id: 'two', relativePath: 'tracks/two.bin', size: 4 },
  ];
  f.bodies.rom = descriptor;
  f.bodies.one = new Uint8Array([1, 2, 3]);
  f.bodies.two = new Uint8Array([4, 5, 6, 7]);
  f.source.name = 'original.cue';
  f.source.size = descriptor.length;
  f.source.groupFileCount = 3;
  f.client.playerProfile = async () => profile;
  f.client.playerProfileAssets = async () => ({ ...resources, assets: [] });
  f.client.sourceGroup = async (id) => ({
    sourceId: id,
    error: null,
    files: f.manifest.files.map((file) => ({
      id: file.id === 'rom' ? 'source' : file.id,
      name: file.relativePath.split('/').at(-1) ?? '',
      relativePath: file.relativePath,
      size: file.size,
      availability: 'local',
    })),
  });
  f.client.collectSource = async (id) => {
    f.events.push(`collect:${id}`);
    return { bytes: f.bodies[id === 'source' ? 'rom' : id] ?? new Uint8Array(), etag: null };
  };
  return { ...f, profile };
}
for (const kind of ['asset', 'source'] as const) {
  test(`${kind} CUE preflights every track before importing code and stages tracks before the entrypoint`, async () => {
    const f = await cueFixture();
    await startPlayer(
      f.client,
      kind === 'asset' ? { kind, itemId: 'item', assetId: 'rom' } : { kind, sourceId: 'source' },
      { canvas: {} as HTMLCanvasElement, importer: f.importer, profileId: f.profile.id },
    );
    assert.ok(f.events.indexOf('collect:two') < f.events.indexOf('import'));
    assert.ok(
      f.events.indexOf('write:/ecs/content/track-001.bin') <
        f.events.indexOf('write:/ecs/content/game.cue'),
    );
    assert.ok(f.events.indexOf('write:/ecs/content/game.cue') < f.events.indexOf('main'));
    assert.deepEqual(f.fs.get('/ecs/content/track-001.bin'), new Uint8Array([4, 5, 6, 7]));
    assert.match(
      new TextDecoder().decode(f.fs.get('/ecs/content/game.cue')),
      /FILE "track-001.bin"/,
    );
  });
}
for (const failure of ['missing', 'evicted', 'changed', 'oversized', 'cancelled'] as const) {
  test(`CUE ${failure} track fails before emulator code is imported`, async () => {
    const f = await cueFixture();
    const group = await f.client.sourceGroup?.('source');
    assert.ok(group);
    const track = group.files.find((file) => file.id === 'two');
    assert.ok(track);
    if (failure === 'missing') group.files = group.files.filter((file) => file.id !== 'two');
    if (failure === 'evicted') track.availability = 'evicted';
    if (failure === 'changed') f.bodies.two = new Uint8Array([4]);
    if (failure === 'oversized') track.size = 1024;
    f.client.sourceGroup = async () => group;
    const abort = new AbortController();
    if (failure === 'cancelled') {
      const collect = f.client.collectSource;
      f.client.collectSource = async (id, options) => {
        const result = await collect(id, options);
        if (id === 'one') abort.abort();
        return result;
      };
    }
    await assert.rejects(
      startPlayer(
        f.client,
        { kind: 'source', sourceId: 'source' },
        {
          canvas: {} as HTMLCanvasElement,
          importer: f.importer,
          profileId: f.profile.id,
          signal: abort.signal,
        },
      ),
    );
    assert.equal(f.events.includes('import'), false);
    if (['missing', 'evicted', 'oversized'].includes(failure))
      assert.equal(f.events.includes('collect:one'), false);
  });
}
test('only profiles advertising CUE offer disc Play links and broken groups stay unavailable', async () => {
  const f = await cueFixture();
  const file = f.manifest.files[0];
  assert.ok(file);
  assert.ok(assetPlayHref(f.profile, f.item, file));
  assert.ok(sourcePlayHref(f.profile, f.source));
  assert.equal(sourcePlayHref({ ...f.profile, contentExtensions: ['bin'] }, f.source), null);
  assert.equal(sourcePlayHref(f.profile, { ...f.source, groupError: 'Missing track' }), null);
  assert.equal(sourcePlayHref(f.profile, { ...f.source, name: 'disc.gdi' }), null);
});

for (const [id, kind] of [
  ['org.flycast.wasm-jit', 'asset'],
  ['org.flycast.wasm-jit', 'source'],
  ['org.flycast.shil-vm', 'source'],
] as const) {
  test(`${id} stages ${kind} GDI tracks and authorized library BIOS`, async () => {
    const f = await cueFixture();
    f.profile.id = id;
    f.profile.systems = ['com.provenance.dreamcast'];
    f.profile.contentExtensions =
      id === 'org.flycast.wasm-jit' ? ['chd', 'cdi', 'elf', 'zip'] : ['chd', 'cdi', 'elf', 'gdi'];
    f.item.systemIdentifier = f.source.systemId = 'com.provenance.dreamcast';
    const descriptor = new TextEncoder().encode(
      '2\n1 0 4 2352 "../tracks/one.bin" 0\n2 450 0 2352 ../tracks/two.bin 0\n',
    );
    const game = f.manifest.files[0];
    assert.ok(game);
    game.relativePath = 'disc/original.gdi';
    game.size = f.source.size = descriptor.length;
    f.source.name = 'original.gdi';
    f.bodies.rom = descriptor;
    const bios = {
      ...f.source,
      id: 'bios',
      name: 'DC_BOOT.BIN',
      kind: 'bios' as const,
      size: 2 * 1024 ** 2,
    };
    const unrelated = { ...bios, id: 'unrelated', libraryId: 'elsewhere' };
    f.client.sources = async () => ({ items: [f.source, unrelated, bios] });
    f.bodies.bios = new Uint8Array(bios.size);
    // The content budget and the system-file budget are independent.
    f.bodies.bios[0] = 42;

    assert.ok(sourcePlayHref(f.profile, f.source));
    assert.ok(assetPlayHref(f.profile, f.item, game));
    await startPlayer(
      f.client,
      kind === 'asset' ? { kind, itemId: 'item', assetId: 'rom' } : { kind, sourceId: 'source' },
      { canvas: {} as HTMLCanvasElement, importer: f.importer, profileId: f.profile.id },
    );
    assert.equal(
      new TextDecoder().decode(f.fs.get('/ecs/content/game.gdi')),
      '2\n1 0 4 2352 track-000.bin 0\n2 450 0 2352 track-001.bin 0\n',
    );
    assert.equal(f.fs.get('/ecs/system/dc/dc_boot.bin')?.[0], 42);
    assert.ok(!f.events.includes('collect:unrelated'));
    assert.ok(f.events.indexOf('write:/ecs/system/dc/dc_boot.bin') < f.events.indexOf('main'));
    assert.match(
      new TextDecoder().decode(f.fs.get('/ecs/core-options.cfg')),
      /reicast_hle_bios = "disabled"/,
    );
  });
}

test('Nestopia loads disksys.rom from the library system-file listing', async () => {
  const f = await cueFixture();
  f.profile.id = 'org.libretro.nestopia';
  f.item.systemIdentifier = 'com.provenance.fds';
  f.profile.systems = [f.item.systemIdentifier];
  f.profile.contentExtensions = ['fds'];
  const game = f.manifest.files[0];
  assert.ok(game);
  game.relativePath = 'game.fds';
  const bios = {
    ...f.source,
    id: 'bios',
    name: 'DISKSYS.ROM',
    kind: 'bios' as const,
    size: 8192,
  };
  f.bodies.bios = new Uint8Array(bios.size);
  f.bodies.bios[0] = 7;
  f.client.browse = async (query) => {
    assert.ok('libraryId' in query);
    assert.equal(query.libraryId, f.item.libraryId);
    assert.equal(query.category, 'system_files');
    return {
      items: [
        {
          ...bios,
          entityType: 'source',
          source: bios,
          canUpload: false,
          canAdopt: false,
        },
      ],
      nextCursor: null,
    };
  };
  f.client.sources = async () => {
    throw new Error('The player should only list system files for uploaded games');
  };
  await startPlayer(
    f.client,
    { kind: 'asset', itemId: 'item', assetId: game.id },
    {
      canvas: {} as HTMLCanvasElement,
      importer: f.importer,
      profileId: f.profile.id,
    },
  );
  assert.equal(f.fs.get('/ecs/system/disksys.rom')?.[0], 7);
  assert.ok(f.events.indexOf('write:/ecs/system/disksys.rom') < f.events.indexOf('main'));
});
