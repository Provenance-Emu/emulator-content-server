import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindDolphinPrototype,
  createDolphinPrototype,
  DOLPHIN_ABI_EXPORTS,
  dolphinSmokeDol,
  requireDolphinIsolation,
  validateDolphinDol,
} from './dolphin-abi.mjs';

function fixture() {
  const memory = new Uint8Array(128);
  const calls = [];
  const module = {
    HEAPU8: memory,
    FS: { mkdirTree: () => {}, writeFile: () => {} },
    ccall(name) {
      return name === 'GetVideoStats' ? 'metadata placeholder' : 1;
    },
  };
  for (const name of DOLPHIN_ABI_EXPORTS)
    module[`_${name}`] = (...args) => {
      calls.push([name, ...args]);
      return 1;
    };
  return { module, calls };
}

test('Dolphin refuses opaque browser contexts before calling a factory', async () => {
  assert.throws(
    () => requireDolphinIsolation({ crossOriginIsolated: false, SharedArrayBuffer }),
    /opaque ECS player/,
  );
  assert.throws(() => requireDolphinIsolation({ crossOriginIsolated: true }), /shared memory/);
  assert.doesNotThrow(() =>
    requireDolphinIsolation({ crossOriginIsolated: true, SharedArrayBuffer }),
  );
  let invoked = false;
  await assert.rejects(
    createDolphinPrototype({
      factory: () => {
        invoked = true;
      },
    }),
    /cross-origin isolation/,
  );
  assert.equal(invoked, false);
});

test('original DOL has valid big-endian sections and rejects invalid memory or entry ranges', () => {
  const dol = dolphinSmokeDol();
  assert.deepEqual(validateDolphinDol(dol), { entry: 0x80003100, counter: 0x80004000 });
  assert.equal(new DataView(dol.buffer).getUint32(0x100, false), 0x3c608000);
  for (const [offset, value] of [
    [0, 0x110],
    [0x48, 0x817ffff0],
    [0xe0, 0x80003000],
    [0xd8, 0x80003100],
  ]) {
    const bad = dol.slice();
    new DataView(bad.buffer).setUint32(offset, value, false);
    assert.throws(() => validateDolphinDol(bad), /DOL/);
  }
  assert.throws(() => validateDolphinDol(new Uint8Array(0x100001)), /1 MiB/);
});

test('metadata frames cannot become emulation acceptance and frame reads stay in WASM memory', () => {
  const { module, calls } = fixture();
  const host = bindDolphinPrototype(module);
  assert.equal(host.frame(), null);
  assert.ok(!calls.some(([name]) => name === 'RunFrame'));
  module.ccall = () => 'xfb:1';
  module._FrameWidth = () => 8;
  module._FrameHeight = () => 8;
  module._FrameBuffer = () => 0;
  assert.throws(() => host.frame(), /exceeds WASM memory/);
  module._FrameWidth = () => 2;
  module._FrameHeight = () => 2;
  const frame = host.frame();
  module.HEAPU8[0] = 255;
  assert.equal(frame.rgba[0], 0, 'frame must own a copy despite concurrent core writes');
});

test('input and audio cannot overrun buffers or silently accept unsupported ABI exports', () => {
  const { module } = fixture();
  const host = bindDolphinPrototype(module);
  assert.throws(() => host.input({ stickX: 300 }), /must be bytes/);
  module._AudioBufferFrames = () => 1024;
  module._AudioChannels = () => 2;
  assert.throws(() => host.audio(1025), /exceeds/);
  module._MixAudio = () => 2;
  module._AudioBuffer = () => 126;
  assert.throws(() => host.audio(2), /exceeds WASM memory/);
  delete module._BootDisc;
  assert.throws(() => bindDolphinPrototype(module), /BootDisc/);
});
