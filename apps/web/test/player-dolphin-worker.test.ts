import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { dolphinWorkerSource } from '../src/player/dolphin-worker.js';

const hashLoader = '0bfc73fbbf370d831fbce04239f062a93f885c053a86866ce5dca3a879be331f';
const hashWasm = 'd7395b3a94080f5b7d08a0522f59096007419d117b7b0eb868246429adee6f5c';
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex')).buffer;
type Reply = {
  type: string;
  id?: number;
  value?: unknown;
  error?: string;
  frame?: { width: number; height: number; pixels: ArrayBuffer };
  audio?: { frames: number; rate: number; samples: ArrayBuffer };
  stats?: { jit: number };
};
async function fixture(t: TestContext) {
  const events: { message: Reply; transfer?: Transferable[] }[] = [],
    waiters = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let next = 0,
    runs = 0,
    stopped = 0,
    terminated = 0,
    unmounted = 0,
    framePointer = 32,
    state = 'Running';
  const pauses: number[] = [],
    writes: string[] = [],
    inputCalls: number[][] = [],
    revoked: string[] = [],
    reads: [number, number][] = [];
  let mounted:
    | { options: { blobs: { name: string; data: Blob }[] }; path: string; reader: Reader }
    | undefined;
  class Reader {
    readAsArrayBuffer(blob: Blob) {
      assert.ok(blob.size <= 4096, 'Only bounded slices may be read');
      return new ArrayBuffer(blob.size);
    }
  }
  const heap = new Uint8Array(new SharedArrayBuffer(1024));
  heap.set([0, 255, 0, 255], 32);
  const work = { name: 'WORKERFS' };
  const runtime: Record<string, unknown> = {
    HEAPU8: heap,
    WORKERFS: work,
    FS: {
      mkdirTree() {},
      writeFile(path: string) {
        writes.push(path);
      },
      mount(filesystem: unknown, options: { blobs: { name: string; data: Blob }[] }, path: string) {
        assert.equal(filesystem, work);
        mounted = { options, path, reader: new Reader() };
      },
      unmount(path: string) {
        assert.equal(path, '/ecs/content');
        unmounted++;
      },
    },
    PThread: {
      terminateAllThreads() {
        terminated++;
      },
    },
    ccall(name: string) {
      return name === 'GetVideoStats' ? 'xfb:1 input:0' : name === 'GetCoreStateName' ? state : 1;
    },
    _GetCoreStateName: () => state,
    _SetCorePaused(value: number) {
      pauses.push(value);
      return 1;
    },
    _CoreInit: () => 1,
    _SetVideoBackend: () => 1,
    _SetCpuCore: () => 1,
    _SetCpuThread: () => 1,
    _SetPpcWasmJitEnabled: () => 1,
    _BootDisc: () => 1,
    _PumpHostJobs() {
      runs++;
    },
    _GetVideoStats() {},
    _GetPpcWasmBlockRunCount: () => runs,
    _GetPpcWasmBlockCompileCount: () => 3,
    _FrameWidth: () => 2,
    _FrameHeight: () => 2,
    _FrameBuffer: () => framePointer,
    _SetInputState(...args: number[]) {
      inputCalls.push(args);
    },
    _MixAudio: () => 4,
    _AudioBuffer: () => 128,
    _AudioBufferFrames: () => 1024,
    _AudioSampleRate: () => 48000,
    _AudioChannels: () => 2,
    _StopCore() {
      stopped++;
    },
  };
  let moduleOptions: Record<string, unknown> | undefined;
  const key = '__ecsDolphinWorkerTestFactory';
  const old = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: async (options: Record<string, unknown>) => {
      moduleOptions = options;
      return runtime;
    },
  });
  t.after(() => {
    if (old) Object.defineProperty(globalThis, key, old);
    else Reflect.deleteProperty(globalThis, key);
  });
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`export default (...args)=>globalThis.${key}(...args)`)}`;
  const scope = {
    crossOriginIsolated: true,
    FileReaderSync: Reader,
    closed: false,
    onmessage: null as null | ((event: { data: unknown }) => void),
    postMessage(message: Reply, transfer?: Transferable[]) {
      events.push({ message, transfer });
      if (message.type === 'result' && message.id) {
        const waiter = waiters.get(message.id);
        waiters.delete(message.id);
        if (message.error) waiter?.reject(Error(message.error));
        else waiter?.resolve(message.value);
      }
    },
    close() {
      scope.closed = true;
    },
  };
  // Evaluation is confined to Node's generated-fixture test; production uses a CSP-governed module worker.
  new Function('self', 'crypto', 'URL', dolphinWorkerSource())(
    scope,
    {
      subtle: {
        digest: async (_algorithm: string, value: ArrayBuffer) =>
          bytes(new Uint8Array(value)[0] === 1 ? hashLoader : hashWasm),
      },
    },
    { createObjectURL: () => moduleUrl, revokeObjectURL: (url: string) => revoked.push(url) },
  );
  const rpc = (op: string, value?: unknown) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      waiters.set(id, { resolve, reject });
      scope.onmessage?.({ data: { id, op, value } });
    });
  await rpc('init', {
    loader: new Uint8Array([1]).buffer,
    wasm: new Uint8Array([2]).buffer,
    maxContentBytes: 9 * 1024 ** 3,
  });
  return {
    pauses,
    setState: (next: string) => {
      state = next;
    },
    rpc,
    scope,
    runtime,
    events,
    writes,
    reads,
    inputCalls,
    revoked,
    mounted: () => mounted,
    moduleOptions: () => moduleOptions,
    counters: () => ({ stopped, terminated, unmounted }),
    badFrame: () => {
      framePointer = 1020;
    },
    tick: async () => {
      const before = events.length;
      scope.onmessage?.({
        data: { type: 'tick', input: [0, 128, 128, 128, 128, 0, 0, 0, 0, 1], audio: true },
      });
      for (let i = 0; i < 50 && events.length === before; i++)
        await new Promise((resolve) => setTimeout(resolve, 0));
      return events.at(-1);
    },
  };
}

test('worker mounts a disk-backed Blob with WORKERFS and reads only slices with its bound FileReaderSync', async (t) => {
  const f = await fixture(t);
  class SparseDisc extends Blob {
    get size() {
      return 8 * 1024 ** 3;
    }
    slice(start = 0, end = this.size) {
      f.reads.push([start, end]);
      return new Blob([new Uint8Array(end - start)]);
    }
    async arrayBuffer(): Promise<ArrayBuffer> {
      throw Error('Whole-disc arrayBuffer is forbidden');
    }
  }
  const disc = new SparseDisc();
  await f.rpc('mount', { path: '/ecs/content/game.iso', file: disc });
  const mounted = f.mounted();
  assert.ok(mounted);
  assert.equal(mounted.path, '/ecs/content');
  assert.equal(mounted.options.blobs[0]?.name, 'game.iso');
  assert.equal(mounted.options.blobs[0]?.data, disc);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.reads, []);
  const offset = 7 * 1024 ** 3;
  assert.equal(mounted.reader.readAsArrayBuffer(disc.slice(offset, offset + 64)).byteLength, 64);
  assert.deepEqual(f.reads, [[offset, offset + 64]]);
  await assert.rejects(f.rpc('mount', { path: '/ecs/content/game.iso', file: disc }));
  await assert.rejects(
    f.rpc('write', { path: '/ecs/content/game.dol', bytes: new ArrayBuffer(4) }),
  );
  assert.equal(typeof f.moduleOptions()?.mainScriptUrlOrBlob, 'string');
  const locate = f.moduleOptions()?.locateFile as (name: string) => string;
  assert.equal(typeof locate('dolphin-core-upstream.wasm'), 'string');
  assert.throws(() => locate('http://external.invalid/core.wasm'));
  await f.rpc('stop');
  assert.equal(f.scope.closed, true);
  assert.deepEqual(f.counters(), { stopped: 1, terminated: 1, unmounted: 1 });
  assert.equal(f.revoked.length, 2);
});

test('worker rejects unsafe mount names and file bounds before native boot', async (t) => {
  const f = await fixture(t),
    file = new Blob([new Uint8Array(16)]);
  for (const path of [
    '/ecs/content/../game.iso',
    '/ecs/content/user.iso',
    '/etc/game.iso',
    '/ecs/content/game.iso/extra',
    '/ecs/content/game.bin',
  ])
    await assert.rejects(f.rpc('mount', { path, file }));
  await assert.rejects(f.rpc('mount', { path: '/ecs/content/game.iso', file: new Blob([]) }));
  await assert.rejects(f.rpc('mount', { path: '/ecs/content/game.iso', file: { size: 12 } }));
  const oversized = new Blob([]);
  Object.defineProperty(oversized, 'size', { value: 9 * 1024 ** 3 + 1 });
  await assert.rejects(f.rpc('mount', { path: '/ecs/content/game.iso', file: oversized }));
  assert.equal(f.mounted(), undefined);
  await f.rpc('stop');
});

test('worker keeps small DOL staging and transfers bounded owned video/audio snapshots', async (t) => {
  const f = await fixture(t);
  await f.rpc('mkdir', '/ecs/content');
  await f.rpc('write', { path: '/ecs/content/game.dol', bytes: new ArrayBuffer(16) });
  await f.rpc('main', ['/ecs/content/game.dol']);
  const packet = await f.tick();
  assert.equal(packet?.message.type, 'tick');
  assert.equal(packet.message.stats?.jit, 1);
  assert.equal(packet.message.frame?.pixels.byteLength, 16);
  assert.equal(packet.message.audio?.samples.byteLength, 16);
  assert.ok(packet.message.frame?.pixels instanceof ArrayBuffer);
  assert.ok(!(packet.message.frame?.pixels instanceof SharedArrayBuffer));
  assert.deepEqual(packet.transfer, [packet.message.frame?.pixels, packet.message.audio?.samples]);
  assert.equal(f.inputCalls[0]?.length, 10);
  assert.deepEqual(f.pauses, [], 'Normal presentation must not pause the core');
  f.badFrame();
  f.runtime._GetVideoStats = () => {};
  f.runtime.ccall = (name: string) => (name === 'GetVideoStats' ? 'xfb:2 input:0' : 1);
  const bad = await f.tick();
  assert.equal(bad?.message.error, 'Dolphin frame failed');
  await f.rpc('stop');
  assert.deepEqual(f.counters(), { stopped: 1, terminated: 1, unmounted: 0 });
});

test('capture pauses only a running core and resumes even if snapshot copying fails', async (t) => {
  const f = await fixture(t);
  await f.rpc('write', { path: '/ecs/content/game.dol', bytes: new ArrayBuffer(16) });
  await f.rpc('main', ['/ecs/content/game.dol']);
  const frame = (await f.rpc('capture')) as { width: number; height: number; pixels: ArrayBuffer };
  assert.equal(frame.pixels.byteLength, 16);
  assert.deepEqual(f.pauses, [1, 0]);
  assert.deepEqual(f.events.at(-1)?.transfer, [frame.pixels]);
  f.setState('Paused');
  await f.rpc('capture');
  assert.deepEqual(f.pauses, [1, 0]);
  f.setState('Running');
  f.badFrame();
  await assert.rejects(f.rpc('capture'));
  assert.deepEqual(f.pauses, [1, 0, 1, 0]);
  await f.rpc('stop');
});
