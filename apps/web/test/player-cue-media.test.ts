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
