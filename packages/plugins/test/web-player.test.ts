import assert from 'node:assert/strict';
import test from 'node:test';
import { parseManifest } from '../src/manifest.js';

const file = { file: 'core.wasm', sha256: 'a'.repeat(64) };
export function manifest() {
  return {
    id: 'org.example.player',
    name: 'Example player',
    kind: 'player',
    version: '1',
    engine: 'ecs.plugin/1',
    apps: ['org.example.app'],
    player: {
      systems: ['com.provenance.nes'],
      module: 'core.wasm',
      web: {
        profileVersion: 1,
        runtime: 'emscripten-esm-v1',
        filesystem: 'memfs',
        threaded: false,
        saveCompletion: 'none',
        contentExtensions: ['nes'],
        maxContentBytes: 1024,
        buildVersion: 'fixture-1',
        loader: { ...file, file: 'loader.js' },
        wasm: file,
        assets: [{ ...file, name: 'support.data', file: 'support.data' }],
      },
    },
  };
}
test('web player profiles are optional and validated without executing code', () => {
  const m = manifest();
  assert.equal(parseManifest(m).player?.web?.runtime, 'emscripten-esm-v1');
  const { web: _, ...legacy } = m.player;
  assert.equal(parseManifest({ ...m, player: legacy }).player?.web, undefined);
});
for (const patch of [
  { threaded: true },
  { filesystem: 'idbfs' },
  { runtime: 'native' },
  { saveCompletion: 'observer' },
  { contentExtensions: ['../rom'] },
  { maxContentBytes: 536870913 },
  { assets: Array(17).fill({ ...file, name: 'a', file: 'a' }) },
  { loader: { ...file, file: '../secret' } },
]) {
  test(`web player rejects unsupported ${Object.keys(patch).join(', ')} profile`, () => {
    const m = manifest();
    assert.throws(() =>
      parseManifest({ ...m, player: { ...m.player, web: { ...m.player.web, ...patch } } }),
    );
  });
}

for (const name of ['CON', 'nul.bin', 'trailing.', '../escape', 'core.wasm']) {
  test(`web player rejects nonportable or reserved asset ${name}`, () => {
    const m = manifest();
    m.player.web.assets[0] = { ...file, file: 'support.data', name };
    assert.throws(() => parseManifest(m));
  });
}

test('disc profiles may declare up to512MiB content without increasing binary resource limits', () => {
  const value = manifest();
  value.player.web.maxContentBytes = 512 * 1024 * 1024;
  assert.equal(parseManifest(value).player?.web?.maxContentBytes, 512 * 1024 * 1024);
  value.player.web.maxContentBytes++;
  assert.throws(() => parseManifest(value), /content size/i);
});

test('Dolphin declares shared memory explicitly and cannot claim RetroArch save completion', () => {
  const m = manifest();
  const web = { ...m.player.web, runtime: 'dolphin-wasm-esm', threaded: true };
  assert.equal(parseManifest({ ...m, player: { ...m.player, web } }).player?.web?.threaded, true);
  for (const patch of [{ threaded: false }, { saveCompletion: 'command-reply-v1' }])
    assert.throws(() =>
      parseManifest({ ...m, player: { ...m.player, web: { ...web, ...patch } } }),
    );
});
