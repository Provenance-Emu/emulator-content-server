import assert from 'node:assert/strict';
import test from 'node:test';
import { startPlayer } from '../src/player/controller.js';
import { fixture } from './player-fixture.js';

const canvas = {} as HTMLCanvasElement;
const selection = { kind: 'asset', itemId: 'item', assetId: 'rom' } as const;
test('complete content and compatible saves are collected before import and staged before main; state actually restores', async () => {
  const f = fixture();
  await startPlayer(f.client, selection, {
    canvas,
    importer: f.importer,
    batteryAssetId: 'battery',
    stateAssetId: 'state',
    compatibleSaves: true,
  });
  assert.deepEqual(f.fs.get('/ecs/content/game.nes'), new Uint8Array([1, 2, 3]));
  assert.deepEqual(f.fs.get('/ecs/saves/game.srm'), new Uint8Array([4, 5]));
  assert.deepEqual(f.fs.get('/ecs/states/game.state'), new Uint8Array([6, 7]));
  assert.ok(f.events.indexOf('collect:state') < f.events.indexOf('import'));
  assert.ok(f.events.indexOf('write:/ecs/saves/game.srm') < f.events.indexOf('main'));
  assert.ok(f.events.indexOf('main') < f.events.indexOf('LOAD_STATE_SLOT 0'));
  assert.equal(f.events.filter((x) => x === 'main').length, 1);
  assert.equal(f.options()?.noInitialRun, true);
  assert.equal(f.options()?.noExitRuntime, true);
  assert.deepEqual(f.options()?.wasmBinary, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  assert.throws(() => f.options()?.locateFile('worker.js'), /unsupported/i);
});
for (const availability of ['offline', 'evicted', 'unknown']) {
  test(`${availability} source never imports or invokes core`, async () => {
    const f = fixture();
    f.source.availability = availability;
    await assert.rejects(
      startPlayer(
        f.client,
        { kind: 'source', sourceId: 'source' },
        { canvas, importer: f.importer },
      ),
    );
    assert.equal(f.events.includes('import'), false);
    assert.equal(f.events.includes('main'), false);
  });
}
for (const kind of ['asset', 'source'] as const) {
  test(`failed ${kind} content preflight never imports core`, async () => {
    const f = fixture();
    f.client.collect = f.client.collectSource = async () => {
      throw new Error('offline race');
    };
    await assert.rejects(
      startPlayer(f.client, kind === 'asset' ? selection : { kind, sourceId: 'source' }, {
        canvas,
        importer: f.importer,
      }),
      /offline race/,
    );
    assert.equal(f.events.includes('import'), false);
  });
}
for (const failure of [
  'system',
  'profile',
  'sdk',
  'size',
  'target',
  'save-compatibility',
  'unauthorized',
]) {
  test(`${failure} fails before importing operator code`, async () => {
    const f = fixture();
    if (failure === 'system') f.item.systemIdentifier = 'com.provenance.snes';
    if (failure === 'profile') f.core.saveCompletion = 'old';
    if (failure === 'sdk') f.core.emscriptenVersion = '6.0.0';
    if (failure === 'size') {
      const file = f.manifest.files[0];
      assert.ok(file);
      file.size = 2048;
    }
    if (failure === 'target') f.source.libraryId = 'other-library';
    if (failure === 'unauthorized')
      f.client.playerCore = async () => {
        throw new Error('unauthorized');
      };
    await assert.rejects(
      startPlayer(
        f.client,
        failure === 'target' ? { kind: 'source', sourceId: 'source', itemId: 'item' } : selection,
        {
          canvas,
          importer: f.importer,
          ...(failure === 'save-compatibility' ? { batteryAssetId: 'battery' } : {}),
        },
      ),
    );
    assert.equal(f.events.includes('import'), false);
  });
}
test('source without a selected item plays without guessing by title, and has no save target', async () => {
  const f = fixture();
  const player = await startPlayer(
    f.client,
    { kind: 'source', sourceId: 'source' },
    { canvas, importer: f.importer },
  );
  assert.equal(player.saves, null);
  assert.deepEqual(f.fs.get('/ecs/content/game.nes'), new Uint8Array([1, 2, 3]));
  assert.equal(f.events.includes('collect:battery'), false);
});
test('missing direct JS helpers fail before main and release the loader URL', async () => {
  const f = fixture();
  delete (f.runtime as Partial<typeof f.runtime>).EmscriptenSendCommand;
  await assert.rejects(
    startPlayer(f.client, selection, { canvas, importer: f.importer }),
    /helpers/,
  );
  assert.equal(f.events.includes('main'), false);
  assert.equal(f.events.includes('release'), true);
});
for (const failure of [
  'wasm',
  'loader-size',
  'worker',
  'worklet',
  'relative-import',
  'dynamic-import',
  'import-scripts',
]) {
  test(`unsupported ${failure} bytes fail before importer/factory invocation`, async () => {
    const f = fixture();
    const get = f.client.playerCoreAssets;
    f.client.playerCoreAssets = async (id) => {
      const assets = await get(id);
      if (failure === 'wasm') assets.wasm.bytes[0] = 1;
      if (failure === 'loader-size') f.core.loader.sizeBytes = 1;
      const text: Record<string, string> = {
        worker: 'new Worker("worker.js")',
        worklet: 'audio.audioWorklet.addModule("audio.js")',
        'relative-import': 'import helper from "./helper.js";',
        'dynamic-import': 'const helper = import("./helper.js");',
        'import-scripts': 'importScripts("./helper.js");',
      };
      if (text[failure]) {
        assets.loader.bytes = new TextEncoder().encode(text[failure]);
        f.core.loader.sizeBytes = assets.loader.bytes.length;
      }
      return assets;
    };
    await assert.rejects(
      startPlayer(f.client, selection, { canvas, importer: f.importer }),
      /unsupported|invalid|size/i,
    );
    assert.equal(f.events.includes('import'), false);
  });
}

test('explicit same-library/system source target wins over similarly titled items and owns uploads', async () => {
  const f = fixture();
  const explicit = { ...f.item, id: 'explicit-target' };
  f.client.items = async (query) => {
    assert.equal(query?.libraryId, 'library');
    return { items: [f.item, explicit], nextCursor: null };
  };
  f.manifest.itemId = explicit.id;
  const session = await startPlayer(
    f.client,
    { kind: 'source', sourceId: 'source', itemId: explicit.id },
    { canvas, importer: f.importer, batteryAssetId: 'battery', compatibleSaves: true },
  );
  assert.equal(session.prepared.item?.id, explicit.id);
  assert.ok(session.saves);
  await session.saves.capture('battery_save');
  assert.equal(f.uploads[0]?.itemId, explicit.id);
  assert.equal(f.uploads[0]?.libraryId, 'library');
  assert.equal(f.uploads[0]?.baseRevision, 7);
});

// The pinned single-thread SDK emits this feature detection without using workers.
test('Emscripten importScripts feature detection does not prevent a self-contained core from starting', async () => {
  const f = fixture();
  const assets = await f.client.playerCoreAssets(f.core.id);
  assets.loader.bytes = new TextEncoder().encode(
    'var ENVIRONMENT_IS_WORKER=typeof importScripts=="function"; export default ()=>({});',
  );
  f.core.loader.sizeBytes = assets.loader.bytes.length;
  f.client.playerCoreAssets = async () => assets;
  await startPlayer(f.client, selection, { canvas, importer: f.importer });
  assert.ok(f.events.includes('main'));
});
