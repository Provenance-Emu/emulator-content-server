/** Experimental Dolphin C ABI host; deliberately not an installable ECS player runtime. */
export const DOLPHIN_ABI_EXPORTS = Object.freeze([
  'CoreInit',
  'SetVideoBackend',
  'SetCpuThread',
  'SetCpuCore',
  'SetPpcWasmJitEnabled',
  'BootDisc',
  'StopCore',
  'PumpHostJobs',
  'GetCoreStateName',
  'GetCoreStatus',
  'GetPPCPC',
  'GetPpcWasmBlockCompileCount',
  'GetPpcWasmBlockRunCount',
  'GetCoreTicksLow',
  'GetCoreTicksHigh',
  'GetCoreTicksPerSecond',
  'GetVideoStats',
  'FrameWidth',
  'FrameHeight',
  'FrameBuffer',
  'SetInputState',
  'AudioSampleRate',
  'AudioChannels',
  'AudioBufferFrames',
  'AudioBuffer',
  'MixAudio',
]);
const MAX_DOL_BYTES = 1024 * 1024;
const RAM_START = 0x80000000;
const RAM_END = 0x81800000;

/** Opaque sandbox frames cannot obtain the SAB required by the pinned core. */
export function requireDolphinIsolation(scope = globalThis) {
  if (scope.crossOriginIsolated !== true || typeof scope.SharedArrayBuffer !== 'function')
    throw new Error(
      'Dolphin requires cross-origin isolation and shared memory; the opaque ECS player is unsupported',
    );
}

/** Original PPC program; a real DOL with a counter at $80004000, no firmware or game. */
export function dolphinSmokeDol() {
  const bytes = new Uint8Array(0x120);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [0, 0x100],
    [0x48, 0x80003100],
    [0x90, 32],
    [0xd8, 0x80004000],
    [0xdc, 32],
    [0xe0, 0x80003100],
  ])
    view.setUint32(offset, value, false);
  [
    0x3c608000, // lis r3,$8000
    0x60634000, // ori r3,r3,$4000
    0x38a00000, // li r5,0
    0x38a50001, // addi r5,r5,1
    0x90a30000, // stw r5,0(r3)
    0x4bfffff8, // b $8000310c
    0x60000000,
    0x60000000,
  ].forEach((instruction, index) => {
    view.setUint32(0x100 + index * 4, instruction, false);
  });
  return bytes;
}

/** Bound this diagnostic loader to complete DOLs in MEM1; original probes place counters in BSS. */
export function validateDolphinDol(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 0x100 || bytes.length > MAX_DOL_BYTES)
    throw new Error('Diagnostic DOL must be between 256 bytes and 1 MiB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ranges = [];
  for (let index = 0; index < 18; index++) {
    const offset = view.getUint32(index * 4, false);
    const address = view.getUint32(0x48 + index * 4, false);
    const size = view.getUint32(0x90 + index * 4, false);
    if (!size) continue;
    if (
      offset < 0x100 ||
      offset + size > bytes.length ||
      address < RAM_START ||
      address + size > RAM_END
    )
      throw new Error('DOL section exceeds its file or GameCube memory bounds');
    if (ranges.some((range) => address < range.end && address + size > range.start))
      throw new Error('DOL sections overlap');
    ranges.push({ start: address, end: address + size, text: index < 7 });
  }
  const entry = view.getUint32(0xe0, false);
  if (!ranges.some((range) => range.text && entry >= range.start && entry < range.end))
    throw new Error('DOL entry point must be inside a text section');
  const bss = view.getUint32(0xd8, false),
    size = view.getUint32(0xdc, false);
  if (
    size &&
    (bss < RAM_START ||
      bss + size > RAM_END ||
      ranges.some((range) => bss < range.end && bss + size > range.start))
  )
    throw new Error('DOL BSS exceeds memory bounds or overlaps a section');
  return { entry, counter: bss };
}

/** Bind only actual emulation APIs: RunFrame and SaveState are upstream diagnostic stubs. */
export function bindDolphinPrototype(module) {
  for (const name of DOLPHIN_ABI_EXPORTS)
    if (typeof module[`_${name}`] !== 'function')
      throw new Error(`Dolphin ABI export missing: ${name}`);
  if (!module.FS || typeof module.ccall !== 'function' || !(module.HEAPU8 instanceof Uint8Array))
    throw new Error('Dolphin filesystem or memory exports missing');
  const call = (name, returnType, types = [], values = []) =>
    module.ccall(name, returnType, types, values);
  const string = (name) => call(name, 'string');
  const memoryRange = (pointer, bytes) => {
    if (
      !Number.isSafeInteger(pointer) ||
      !Number.isSafeInteger(bytes) ||
      pointer < 0 ||
      bytes < 0 ||
      pointer + bytes > module.HEAPU8.byteLength
    )
      throw new Error('Dolphin buffer exceeds WASM memory');
    return module.HEAPU8.subarray(pointer, pointer + bytes);
  };
  let started = false;
  return {
    bootDol(bytes) {
      if (started) throw new Error('Create a fresh Dolphin worker before another boot');
      validateDolphinDol(bytes);
      if (
        !call('SetVideoBackend', 'number', ['string'], ['Software Renderer']) ||
        !call('SetCpuCore', 'number', ['string'], ['cached']) ||
        !module._SetCpuThread(0)
      )
        throw new Error('Dolphin configuration must precede initialization');
      module._SetPpcWasmJitEnabled(1);
      module.FS.mkdirTree('/ecs/diagnostic');
      module.FS.writeFile('/ecs/diagnostic/original.dol', bytes);
      if (
        module._CoreInit() !== 1 ||
        call('BootDisc', 'number', ['string'], ['/ecs/diagnostic/original.dol']) !== 1
      )
        throw new Error(`Dolphin boot rejected: ${string('GetCoreStatus')}`);
      started = true;
    },
    poll() {
      module._PumpHostJobs();
      return {
        state: string('GetCoreStateName'),
        status: string('GetCoreStatus'),
        pc: module._GetPPCPC() >>> 0,
        ticksPerSecond: module._GetCoreTicksPerSecond(),
        jitCompiled: module._GetPpcWasmBlockCompileCount(),
        jitRuns: module._GetPpcWasmBlockRunCount(),
        ticks:
          (BigInt(module._GetCoreTicksHigh() >>> 0) << 32n) |
          BigInt(module._GetCoreTicksLow() >>> 0),
      };
    },
    frame() {
      // The shim paints a metadata placeholder before the emulated VI emits an XFB.
      const videoStats = string('GetVideoStats');
      const sequence = /^xfb:([1-9][0-9]*)(?:\s|$)/.exec(videoStats);
      if (!sequence) return null;
      const width = module._FrameWidth(),
        height = module._FrameHeight();
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 2048 ||
        height > 2048
      )
        throw new Error('Dolphin frame dimensions exceed the prototype limit');
      const bytes = memoryRange(module._FrameBuffer(), width * height * 4);
      return {
        width,
        height,
        sequence: Number(sequence[1]),
        videoStats,
        rgba: new Uint8ClampedArray(bytes),
      };
    },
    audio(frames = 1024) {
      const capacity = module._AudioBufferFrames();
      if (
        !Number.isInteger(frames) ||
        frames < 1 ||
        frames > capacity ||
        frames > 8192 ||
        module._AudioChannels() !== 2
      )
        throw new Error('Dolphin audio request exceeds the prototype limit');
      const mixed = module._MixAudio(frames);
      if (mixed < 0 || mixed > frames) throw new Error('Invalid Dolphin audio frame count');
      const bytes = memoryRange(module._AudioBuffer(), mixed * 4);
      return {
        sampleRate: module._AudioSampleRate(),
        channels: 2,
        samples: new Int16Array(bytes.slice().buffer),
      };
    },
    input({
      mask = 0,
      stickX = 128,
      stickY = 128,
      cStickX = 128,
      cStickY = 128,
      triggerLeft = 0,
      triggerRight = 0,
      analogA = 0,
      analogB = 0,
      generation = 0,
    } = {}) {
      const axes = [stickX, stickY, cStickX, cStickY, triggerLeft, triggerRight, analogA, analogB];
      if (!axes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255))
        throw new Error('Dolphin pad values must be bytes');
      module._SetInputState(mask >>> 0, ...axes, generation >>> 0);
    },
    stop() {
      if (started) module._StopCore();
      started = false;
    },
  };
}

/** Future runtime seam: verified bytes/factory arrive from a broker, never arbitrary URLs. */
export async function createDolphinPrototype({ factory, wasmBinary, moduleOptions = {} }) {
  requireDolphinIsolation();
  const module = await factory({ ...moduleOptions, wasmBinary, noInitialRun: true });
  if (!(module.HEAPU8?.buffer instanceof SharedArrayBuffer))
    throw new Error('Pinned Dolphin build must use shared memory');
  return bindDolphinPrototype(module);
}
