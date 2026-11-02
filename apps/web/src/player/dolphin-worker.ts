/** Serialized first-party main-core worker. It must have no outer runtime dependencies. */
function dolphinCoreWorker() {
  type Module = {
    HEAPU8: Uint8Array;
    FS: {
      mkdirTree(path: string): void;
      writeFile(path: string, bytes: Uint8Array): void;
      mount(
        filesystem: unknown,
        options: { blobs: { name: string; data: Blob }[] },
        path: string,
      ): void;
      unmount(path: string): void;
    };
    WORKERFS: unknown;
    PThread?: { terminateAllThreads(): void };
    ccall(name: string, type: string, types?: string[], values?: unknown[]): unknown;
    [name: string]: unknown;
  };
  const scope = self as unknown as {
    crossOriginIsolated: boolean;
    onmessage:
      | ((event: {
          data: {
            id?: number;
            op?: string;
            type?: string;
            value?: unknown;
            input?: unknown;
            audio?: unknown;
          };
        }) => void)
      | null;
    postMessage(value: unknown, transfer?: Transferable[]): void;
    close(): void;
  };
  const urls: string[] = [],
    sizes = new Map<string, number>();
  let runtime: Module | undefined,
    started = false,
    closed = false,
    initialized = false;
  let mounted = false,
    contentBytes = 0,
    maxContentBytes = 0,
    drawn = 0,
    tail = Promise.resolve();
  let logStart = Date.now(),
    logCount = 0;
  const log = (value: unknown) => {
    if (Date.now() - logStart > 1000) {
      logStart = Date.now();
      logCount = 0;
    }
    if (!closed && ++logCount <= 30)
      scope.postMessage({ type: 'log', text: String(value).slice(0, 500) });
  };
  const blob = (bytes: ArrayBuffer, type: string) => {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    urls.push(url);
    return url;
  };
  function module(): Module {
    if (!runtime) throw Error('Dolphin is not initialized');
    return runtime;
  }
  function native(name: string, ...args: number[]): number {
    const fn = module()[`_${name}`];
    if (typeof fn !== 'function') throw Error('Dolphin ABI missing');
    return Number(fn(...args));
  }
  function call(name: string, type: string, types: string[] = [], values: unknown[] = []) {
    return module().ccall(name, type, types, values);
  }
  function range(pointer: number, length: number): Uint8Array {
    const heap = module().HEAPU8;
    if (
      !Number.isSafeInteger(pointer) ||
      pointer < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      pointer > heap.length - length
    )
      throw Error('Invalid emulator memory range');
    return heap.subarray(pointer, pointer + length);
  }
  function dispose() {
    if (closed) return;
    started = false;
    try {
      const stop = runtime?._StopCore;
      if (typeof stop === 'function') stop();
    } catch {}
    try {
      runtime?.PThread?.terminateAllThreads();
    } catch {}
    try {
      if (mounted) runtime?.FS.unmount('/ecs/content');
    } catch {}
    for (const url of urls) URL.revokeObjectURL(url);
    urls.length = 0;
    sizes.clear();
    runtime = undefined;
    closed = true;
  }
  function stats() {
    const video = call('GetVideoStats', 'string');
    if (typeof video !== 'string' || video.length > 4096) throw Error('Invalid video status');
    const jit = native('GetPpcWasmBlockRunCount'),
      compiled = native('GetPpcWasmBlockCompileCount');
    if (![jit, compiled].every((n) => Number.isFinite(n) && n >= 0))
      throw Error('Invalid JIT status');
    return { video, jit, compiled };
  }
  function copyFrame(video: string): { width: number; height: number; pixels: ArrayBuffer } {
    if (!/^xfb:([1-9][0-9]*)\b/.test(video)) throw Error('No emulated video frame yet');
    const width = native('FrameWidth'),
      height = native('FrameHeight');
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 2048 ||
      height > 2048
    )
      throw Error('Emulator frame exceeds display bounds');
    const pixels = new Uint8Array(width * height * 4);
    pixels.set(range(native('FrameBuffer'), pixels.length));
    return { width, height, pixels: pixels.buffer };
  }
  function tick(input: unknown, audio: unknown) {
    if (!started || closed) return;
    try {
      if (
        !Array.isArray(input) ||
        input.length !== 10 ||
        input.some(
          (n, i) =>
            !Number.isInteger(n) || n < 0 || n > (i === 0 ? 4095 : i === 9 ? 0xffffffff : 255),
        )
      )
        throw Error('Invalid controller state');
      native('SetInputState', ...input);
      native('PumpHostJobs');
      const state = stats(),
        match = /^xfb:([1-9][0-9]*)\b/.exec(state.video),
        transfer: Transferable[] = [];
      let frame: { width: number; height: number; pixels: ArrayBuffer } | undefined;
      if (match && Number(match[1]) !== drawn) {
        frame = copyFrame(state.video);
        transfer.push(frame.pixels);
        drawn = Number(match[1]);
      }
      let sound: { rate: number; frames: number; samples: ArrayBuffer } | undefined;
      if (audio === true) {
        const capacity = native('AudioBufferFrames'),
          rate = native('AudioSampleRate');
        if (
          !Number.isInteger(capacity) ||
          capacity < 1 ||
          capacity > 65536 ||
          !Number.isInteger(rate) ||
          rate < 8000 ||
          rate > 192000 ||
          native('AudioChannels') !== 2
        )
          throw Error('Invalid emulator audio layout');
        const count = native('MixAudio', Math.min(1024, capacity));
        if (!Number.isInteger(count) || count < 0 || count > Math.min(1024, capacity))
          throw Error('Invalid emulator audio count');
        if (count) {
          const samples = new Uint8Array(count * 4);
          samples.set(range(native('AudioBuffer'), samples.length));
          sound = { rate, frames: count, samples: samples.buffer };
          transfer.push(samples.buffer);
        }
      }
      scope.postMessage({ type: 'tick', stats: state, frame, audio: sound }, transfer);
    } catch (error) {
      started = false;
      log(error instanceof Error ? error.message : error);
      scope.postMessage({ type: 'tick', error: 'Dolphin frame failed' });
    }
  }
  async function operation(op: string, raw: unknown): Promise<unknown> {
    const value = raw as Record<string, unknown> | undefined;
    if (op === 'init') {
      if (
        initialized ||
        !scope.crossOriginIsolated ||
        typeof SharedArrayBuffer !== 'function' ||
        typeof (self as unknown as { FileReaderSync?: unknown }).FileReaderSync !== 'function'
      )
        throw Error('Dolphin requires an isolated filesystem worker');
      initialized = true;
      if (
        !(value?.loader instanceof ArrayBuffer) ||
        !value.loader.byteLength ||
        value.loader.byteLength > 8388608 ||
        !(value.wasm instanceof ArrayBuffer) ||
        !value.wasm.byteLength ||
        value.wasm.byteLength > 67108864
      )
        throw Error('Unsupported Dolphin resources');
      if (
        !Number.isSafeInteger(value.maxContentBytes) ||
        Number(value.maxContentBytes) < 1 ||
        Number(value.maxContentBytes) > 9 * 1024 ** 3
      )
        throw Error('Invalid content bound');
      maxContentBytes = Number(value.maxContentBytes);
      const digest = async (bytes: ArrayBuffer) =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('');
      if (
        (await digest(value.loader)) !==
          '0bfc73fbbf370d831fbce04239f062a93f885c053a86866ce5dca3a879be331f' ||
        (await digest(value.wasm)) !==
          'd7395b3a94080f5b7d08a0522f59096007419d117b7b0eb868246429adee6f5c'
      )
        throw Error('Unreviewed Dolphin build');
      const loader = blob(value.loader, 'text/javascript'),
        wasm = blob(value.wasm, 'application/wasm');
      const factory = (await import(loader)).default;
      runtime = await factory({
        wasmBinary: new Uint8Array(value.wasm),
        noInitialRun: true,
        noExitRuntime: true,
        mainScriptUrlOrBlob: loader,
        locateFile: (name: string) => {
          if (name === 'dolphin-core-upstream.wasm') return wasm;
          throw Error('Unexpected secondary resource');
        },
        print: log,
        printErr: log,
      });
      const core = module();
      if (
        !(core.HEAPU8?.buffer instanceof SharedArrayBuffer) ||
        !core.FS ||
        !core.WORKERFS ||
        typeof core.FS.mount !== 'function' ||
        typeof core.ccall !== 'function'
      )
        throw Error('Invalid Dolphin runtime');
      for (const name of [
        'CoreInit',
        'SetVideoBackend',
        'SetCpuCore',
        'SetCpuThread',
        'SetPpcWasmJitEnabled',
        'BootDisc',
        'PumpHostJobs',
        'FrameWidth',
        'FrameHeight',
        'FrameBuffer',
        'GetVideoStats',
        'SetInputState',
        'MixAudio',
        'AudioBuffer',
        'AudioBufferFrames',
        'AudioSampleRate',
        'AudioChannels',
        'GetPpcWasmBlockRunCount',
        'GetPpcWasmBlockCompileCount',
        'GetCoreStateName',
        'SetCorePaused',
      ])
        if (typeof core[`_${name}`] !== 'function') throw Error('Dolphin ABI missing');
      /* Verify initialized module memory. */
      return null;
    }
    if (op === 'stop') {
      dispose();
      return null;
    }
    const core = module();
    switch (op) {
      case 'mkdir':
        if (typeof raw !== 'string' || !/^\/ecs(?:\/(?:content|saves|states|system))?$/.test(raw))
          throw Error('Invalid directory');
        core.FS.mkdirTree(raw);
        return null;
      case 'write': {
        const path = value?.path,
          bytes = value?.bytes;
        if (
          typeof path !== 'string' ||
          !/^\/ecs\/(?:content\/[A-Za-z0-9_.-]{1,100}|(?:retroarch|core-options)\.cfg)$/.test(
            path,
          ) ||
          !(bytes instanceof ArrayBuffer) ||
          started ||
          (mounted && path.startsWith('/ecs/content/'))
        )
          throw Error('Invalid staged file');
        const content = path.startsWith('/ecs/content/'),
          total = contentBytes - (sizes.get(path) ?? 0) + bytes.byteLength;
        if (
          content
            ? total > Math.min(maxContentBytes, 64 * 1024 ** 2) ||
              (!sizes.has(path) && sizes.size >= 128)
            : bytes.byteLength > 65536
        )
          throw Error('Staged file exceeds limit; mount disc files instead');
        core.FS.writeFile(path, new Uint8Array(bytes));
        if (content) {
          contentBytes = total;
          sizes.set(path, bytes.byteLength);
        }
        return null;
      }
      case 'mount': {
        const path = value?.path,
          file = value?.file;
        if (
          started ||
          mounted ||
          sizes.size ||
          typeof path !== 'string' ||
          !/^\/ecs\/content\/game\.(dol|elf|iso|gcm|gcz|rvz|wia|ciso)$/.test(path) ||
          !(file instanceof Blob) ||
          !Number.isSafeInteger(file.size) ||
          file.size < 1 ||
          file.size > maxContentBytes
        )
          throw Error('Invalid disk-backed content');
        core.FS.mkdirTree('/ecs/content');
        core.FS.mount(
          core.WORKERFS,
          { blobs: [{ name: path.slice('/ecs/content/'.length), data: file }] },
          '/ecs/content',
        );
        mounted = true;
        sizes.set(path, file.size);
        contentBytes = file.size;
        return null;
      }
      case 'capture': {
        if (!started) throw Error('No emulated video frame yet');
        const wasRunning = call('GetCoreStateName', 'string') === 'Running';
        let requestedPause = false;
        try {
          if (wasRunning) {
            requestedPause = true;
            if (native('SetCorePaused', 1) !== 1) throw Error('Dolphin pause rejected');
          }
          return copyFrame(stats().video);
        } finally {
          if (requestedPause) native('SetCorePaused', 0);
        }
      }
      case 'main': {
        if (
          started ||
          !Array.isArray(raw) ||
          raw.length !== 1 ||
          typeof raw[0] !== 'string' ||
          !/^\/ecs\/content\/game\.(dol|elf|iso|gcm|gcz|rvz|wia|ciso)$/.test(raw[0]) ||
          !sizes.has(raw[0])
        )
          throw Error('Invalid Dolphin boot target');
        if (
          !call('SetVideoBackend', 'number', ['string'], ['Software Renderer']) ||
          !call('SetCpuCore', 'number', ['string'], ['cached']) ||
          !native('SetCpuThread', 0)
        )
          throw Error('Dolphin configuration rejected');
        native('SetPpcWasmJitEnabled', 1);
        const scale = core._SetPresentationScale;
        if (typeof scale === 'function') scale(1);
        if (native('CoreInit') !== 1 || call('BootDisc', 'number', ['string'], [raw[0]]) !== 1)
          throw Error('Dolphin boot rejected');
        started = true;
        return null;
      }
      default:
        throw Error('Unsupported Dolphin worker operation');
    }
  }
  scope.onmessage = (event) => {
    if (closed) return;
    const message = event.data;
    tail = tail.then(async () => {
      if (closed) return;
      if (message?.type === 'tick') {
        tick(message.input, message.audio);
        return;
      }
      if (
        !Number.isSafeInteger(message?.id) ||
        Number(message.id) < 1 ||
        typeof message.op !== 'string'
      )
        return;
      try {
        const value = await operation(message.op, message.value);
        const transfer =
          message.op === 'capture' ? [(value as { pixels: ArrayBuffer }).pixels] : [];
        scope.postMessage({ type: 'result', id: message.id, value }, transfer);
        if (message.op === 'stop') scope.close();
      } catch (error) {
        log(error instanceof Error ? error.message : error);
        scope.postMessage({
          type: 'result',
          id: message.id,
          error: 'Dolphin worker operation failed',
        });
        if (message.op === 'init') {
          dispose();
          scope.close();
        }
      }
    });
  };
}

/** The reviewed source is sent through the existing private bootstrap channel. */
export function dolphinWorkerSource(): string {
  return `(${dolphinCoreWorker.toString()})();`;
}
