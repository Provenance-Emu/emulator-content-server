import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebPlayerDescriptor } from '@ecs/client';
import { approvedDolphinBuild, dolphinBuild, isolatedPlayerUrl } from '../src/player/dolphin.js';
import { validateProfile } from '../src/player/runtime.js';

const profile = {
  profileVersion: 1,
  id: dolphinBuild.id,
  name: 'Dolphin',
  systems: ['com.provenance.gamecube'],
  runtime: 'dolphin-wasm-esm',
  threaded: true,
  filesystem: 'memfs',
  saveCompletion: 'none',
  contentExtensions: ['dol'],
  maxContentBytes: 1024,
  buildVersion: 'reviewed',
  assets: [],
  loader: { url: '/loader.js', sizeBytes: 266969, sha256: dolphinBuild.loader },
  wasm: { url: '/core.wasm', sizeBytes: 15175335, sha256: dolphinBuild.wasm },
} as unknown as WebPlayerDescriptor;

test('only the approved Dolphin pair can select the threaded runtime', () => {
  assert.equal(approvedDolphinBuild(profile), true);
  assert.doesNotThrow(() => validateProfile(profile));
  for (const patch of [
    { threaded: false },
    { saveCompletion: 'command-reply-v1' },
    { loader: { ...profile.loader, sha256: 'a'.repeat(64) } },
    { runtime: 'retroarch-emscripten-esm' },
  ])
    assert.throws(() => validateProfile({ ...profile, ...patch } as WebPlayerDescriptor));
});

test('the companion origin must differ from the authenticated app, with no injected credentials', () => {
  const good = {
    id: 'a'.repeat(32),
    url: 'http://127.0.0.1:59812/session/',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  assert.equal(isolatedPlayerUrl(good, 'http://127.0.0.1:8473').port, '59812');
  for (const url of [
    'http://127.0.0.1:8473/play/',
    'http://localhost:59812/',
    'https://evil.test/',
    'http://user:pass@127.0.0.1:59812/',
    `${good.url}?token=secret`,
    `${good.url}#secret`,
  ])
    assert.throws(() => isolatedPlayerUrl({ ...good, url }, 'http://127.0.0.1:8473'));
  assert.throws(() =>
    isolatedPlayerUrl({ ...good, expiresAt: '2000-01-01' }, 'http://127.0.0.1:8473'),
  );
});

test('GameCube defaults include both sticks and Z while preserving a saved layout', async () => {
  const { createInputPreferences } = await import('../src/player/input-preferences.js');
  const { defaultLayout } = await import('../src/player/layout.js');
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const store = createInputPreferences('http://127.0.0.1:8473', profile, undefined, storage);
  const controls = store.load().layout.representations.landscape.controls;
  for (const action of ['a', 'b', 'x', 'y', 'l', 'r', 'leftStick', 'rightStick', 'select', 'start'])
    assert.ok(controls.some((c) => c.action === action));
  assert.ok(
    controls.some(
      (c) => c.action === 'select' && c.visual.kind === 'shape' && c.visual.label === 'Z',
    ),
  );
  const compact = defaultLayout('compact').representations.landscape;
  store.remember('core', { 'layout.landscape': compact });
  assert.deepEqual(store.load().layout.representations.landscape, compact);
});

test('invalid runtime deadlines allocate no companion listener', async () => {
  const { importIsolatedRuntime } = await import('../src/player/sandbox.js');
  let creates = 0;
  const loaded = await importIsolatedRuntime(new Uint8Array(), {
    profile,
    timeoutMs: 0,
    isolation: {
      create: async () => {
        creates++;
        throw new Error('Should not allocate');
      },
      close: async () => {},
    },
  });
  await assert.rejects(
    loaded.factory({
      wasmBinary: new Uint8Array(),
      noInitialRun: true,
      noExitRuntime: true,
      canvas: {} as HTMLCanvasElement,
      locateFile: (path) => path,
      print: () => {},
      printErr: () => {},
    }),
    /Invalid runtime deadline/,
  );
  assert.equal(creates, 0);
});
