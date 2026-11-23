import assert from 'node:assert/strict';
import test from 'node:test';
import { detectFeatures, FEATURES, runtimeNeeds } from '../src/lib/browser-features.js';

test('a browser with nothing optional is reported as having nothing, without throwing', () => {
  const features = detectFeatures({});
  assert.deepEqual(
    features.list().filter((feature) => feature.available),
    [],
  );
  assert.deepEqual(
    features.missing(runtimeNeeds('dolphin-wasm-esm')).map((feature) => feature.id),
    ['isolation.sharedMemory', 'wasm.threads', 'storage.files'],
  );
  assert.deepEqual(features.missing(runtimeNeeds('libretro')), []);
});

test('abilities are found by asking for them, never by the browser name', () => {
  let asked = 0;
  const features = detectFeatures({
    WebAssembly,
    crossOriginIsolated: true,
    SharedArrayBuffer,
    navigator: {
      // A browser name that would mislead any check that read it.
      userAgent: 'Unknown/0.1',
      gpu: {},
      hid: {},
      storage: {
        getDirectory() {
          asked++;
        },
      },
      wakeLock: { request() {} },
      getGamepads: () => [],
    },
    CSS: { supports: (condition: string) => condition === 'height: 100dvh' },
  });
  for (const id of [
    'wasm.simd',
    'wasm.threads',
    'isolation.sharedMemory',
    'graphics.webgpu',
    'input.hid',
    'input.gamepad',
    'storage.files',
    'screen.wakeLock',
    'layout.dynamicViewport',
  ])
    assert.equal(features.has(id), true, id);
  assert.equal(features.has('input.serial'), false);
  assert.equal(features.has('layout.has'), false);
  // Detecting storage never opens it.
  assert.equal(asked, 0);
});

test('threads need shared memory, whatever the emulator format allows', () => {
  assert.equal(detectFeatures({ WebAssembly }).has('wasm.threads'), false);
});

test('every feature has a unique id, a group and a plain label', () => {
  assert.equal(new Set(FEATURES.map((feature) => feature.id)).size, FEATURES.length);
  for (const feature of FEATURES) {
    assert.match(feature.id, /^[a-z]+\.[A-Za-z0-9]+$/);
    assert.ok(feature.label.length > 2);
  }
});
