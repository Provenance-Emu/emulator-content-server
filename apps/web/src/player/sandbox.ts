import { type IsolationSession, isolatedPlayerUrl } from './dolphin.js';
import { PREVIEW_LIMIT, pngInfo, SCREENSHOT_LIMIT } from './images.js';
import { inputBridgeSource } from './input-bridge.js';
import { createInputEngine } from './input-engine.js';
import { defaultMapping, type InputInfo } from './input-model.js';
import { validOptionKey, validOptionValue } from './options.js';
import type { PlayerRuntime, RuntimeContext, RuntimeImporter } from './runtime.js';
import { type DisplayInfo, validDisplaySettings } from './runtime.js';
import {
  builtinShaders,
  type SettingsInfo,
  type ShaderResult,
  validShaderId,
  validShaderResult,
} from './shaders.js';

const LIMIT = 64 * 1024 * 1024;
/** Core code receives bytes through a private port, never the app client, origin or credentials. */
export const importIsolatedRuntime: RuntimeImporter = async (
  loader,
  context: RuntimeContext = {},
) => {
  let disposed = false;
  let stop: ((error?: Error) => void) | undefined;
  const release = () => {
    disposed = true;
    stop?.(new Error('Emulator session closed'));
  };
  return {
    release,
    async factory(options) {
      if (disposed || context.signal?.aborted) throw new Error('Emulator startup was cancelled');
      if (loader.byteLength > 8 * 1024 * 1024 || options.wasmBinary.byteLength > LIMIT)
        throw new Error('Core artifact exceeds limit');
      const timeout = context.timeoutMs ?? 30000;
      if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 30000)
        throw new Error('Invalid runtime deadline');
      const profile = context.profile,
        broker = context.isolation;
      const dolphin = profile?.runtime === 'dolphin-wasm-esm';
      if (dolphin && (globalThis.crossOriginIsolated !== true || !context.isolation))
        throw new Error(
          'Dolphin needs the isolated browser-player page on the server computer. Open the game from /play/.',
        );
      let isolation: IsolationSession | undefined;
      let isolatedUrl: URL | undefined;
      if (dolphin && broker && profile) {
        isolation = await broker.create(profile.id);
        try {
          isolatedUrl = isolatedPlayerUrl(isolation, window.location.origin);
          if (disposed || context.signal?.aborted)
            throw new Error('Emulator startup was cancelled');
        } catch (error) {
          await broker.close(isolation.id).catch(() => {});
          throw error;
        }
      }
      const oldDisplay = options.canvas.style.display;
      const oldHidden = options.canvas.hidden;
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', dolphin ? 'allow-scripts allow-same-origin' : 'allow-scripts');
      frame.referrerPolicy = 'no-referrer';
      frame.allow = `gamepad *; autoplay *; fullscreen *${dolphin ? '; cross-origin-isolated *' : ''}`;
      frame.allowFullscreen = true;
      frame.title = 'Isolated game display';
      frame.className = options.canvas.className;
      frame.style.border = '0';
      frame.style.width = '100%';
      frame.style.height = '100%';
      const entropy = crypto.getRandomValues(new Uint8Array(16));
      const nonce = Array.from(entropy, (b) => b.toString(16).padStart(2, '0')).join('');
      frame.src = `${isolatedUrl?.href ?? '/play/sandbox.html'}#${nonce}`;
      const expectedOrigin = isolatedUrl?.origin ?? 'null';
      const channel = new MessageChannel();
      let next = 0,
        closed = false,
        ready = false,
        connected = false;
      const pending = new Map<
        number,
        {
          resolve: (value: unknown) => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
          op: string;
        }
      >();
      let handshakeResolve: () => void, handshakeReject: (error: Error) => void;
      const handshake = new Promise<void>((resolve, reject) => {
        handshakeResolve = resolve;
        handshakeReject = reject;
      });
      const bootTimer = setTimeout(
        () => close(new Error('Emulator startup timed out')),
        Math.min(timeout, 15000),
      );
      const abort = () => close(new Error('Emulator startup was cancelled'));
      function close(error = new Error('Emulator session closed')) {
        if (closed) return;
        closed = true;
        disposed = true;
        clearTimeout(bootTimer);
        window.removeEventListener('message', onready);
        context.signal?.removeEventListener('abort', abort);
        channel.port1.close();
        channel.port2.close();
        frame.remove();
        if (isolation) void context.isolation?.close(isolation.id).catch(() => {});
        options.canvas.hidden = oldHidden;
        options.canvas.style.display = oldDisplay;
        handshakeReject(error);
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(error);
        }
        pending.clear();
      }
      stop = close;
      function onready(event: MessageEvent) {
        if (
          closed ||
          ready ||
          event.source !== frame.contentWindow ||
          event.origin !== expectedOrigin ||
          event.data?.type !== 'ecs-player-ready' ||
          event.data.nonce !== nonce
        )
          return;
        ready = true;
        window.removeEventListener('message', onready);
        frame.contentWindow?.postMessage(
          { type: 'ecs-player-connect', nonce },
          dolphin ? expectedOrigin : '*',
          [channel.port2],
        );
      }
      channel.port1.onmessage = (event) => {
        if (closed) return;
        const message = event.data;
        if (message?.type === 'connected' && ready && !connected) {
          connected = true;
          clearTimeout(bootTimer);
          handshakeResolve();
          return;
        }
        if (
          message?.type === 'log' &&
          connected &&
          typeof message.text === 'string' &&
          message.text.length <= 500
        ) {
          options.print(message.text);
          return;
        }
        if (message?.type !== 'result' || !Number.isSafeInteger(message.id)) return;
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (typeof message.error === 'string') {
          request.reject(new Error(message.error.slice(0, 300)));
          return;
        }
        const value = message.value;
        if (
          (request.op === 'read' &&
            (!(value instanceof ArrayBuffer) || value.byteLength > LIMIT)) ||
          (request.op === 'receive' &&
            value !== undefined &&
            (typeof value !== 'string' || value.length > 60000))
        ) {
          request.reject(new Error('Invalid emulator reply'));
          close();
          return;
        }
        request.resolve(value);
      };
      channel.port1.start();
      window.addEventListener('message', onready);
      context.signal?.addEventListener('abort', abort, { once: true });
      options.canvas.before(frame);
      options.canvas.hidden = true;
      options.canvas.style.display = 'none';
      async function rpc(
        op: string,
        value?: unknown,
        transfer: Transferable[] = [],
      ): Promise<unknown> {
        if (closed || disposed || context.signal?.aborted)
          throw new Error('Emulator session closed');
        if (pending.size >= 32) throw new Error('Too many emulator operations');
        const id = ++next;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('Emulator operation timed out'));
            close();
          }, timeout);
          pending.set(id, { resolve, reject, timer, op });
          try {
            channel.port1.postMessage({ id, op, value }, transfer);
          } catch {
            clearTimeout(timer);
            pending.delete(id);
            reject(new Error('Emulator message failed'));
            close();
          }
        });
      }
      try {
        await handshake;
        const script = loader.slice().buffer,
          wasm = options.wasmBinary.slice().buffer;
        const assets = (context.assets ?? []).map((asset) => ({
          name: asset.name,
          bytes: asset.bytes.slice().buffer,
        }));
        await rpc(
          'init',
          {
            loader: script,
            wasm,
            assets,
            maxContentBytes: context.profile?.maxContentBytes ?? LIMIT,
            commands: context.profile?.saveCompletion !== 'none',
            shaders: builtinShaders,
            inputEnabled: context.inputEnabled === true,
            inputModule: context.inputEnabled ? inputBridgeSource() : undefined,
            inputConfig: context.inputEnabled ? defaultMapping() : undefined,
          },
          [script, wasm, ...assets.map((asset) => asset.bytes)],
        );
        const contentSizes = new Map<string, number>();
        let contentBytes = 0;
        const runtime: PlayerRuntime = {
          FS: {
            mkdirTree: async (path) => {
              await rpc('mkdir', path);
            },
            writeFile: async (path, bytes) => {
              const content = path.startsWith('/ecs/content/');
              const total = contentBytes - (contentSizes.get(path) ?? 0) + bytes.byteLength;
              if (
                content &&
                (total > (context.profile?.maxContentBytes ?? LIMIT) ||
                  (!contentSizes.has(path) && contentSizes.size >= 128))
              )
                throw new Error('Complete disc exceeds runtime content limit');
              if (
                bytes.byteLength > (content ? (context.profile?.maxContentBytes ?? LIMIT) : LIMIT)
              )
                throw new Error('Virtual file exceeds limit');
              const buffer = new Uint8Array(bytes).buffer;
              await rpc('write', { path, bytes: buffer }, [buffer]);
              if (content) {
                contentBytes = total;
                contentSizes.set(path, bytes.byteLength);
              }
            },
            readFile: async (path) => new Uint8Array((await rpc('read', path)) as ArrayBuffer),
          },
          callMain: async (args) => {
            await rpc('main', args);
          },
          EmscriptenSendCommand: async (command) => {
            if (!['SAVE_FILES', 'SAVE_STATE_SLOT 0', 'LOAD_STATE_SLOT 0'].includes(command)) {
              const query = /^GET_CORE_OPTION(?: ([^ ]+))?$/.exec(command);
              const set = /^SET_CORE_OPTION ([^ ]+) (.+)$/.exec(command);
              if (
                !(query && (query[1] === undefined || validOptionKey(query[1]))) &&
                !(set && validOptionKey(set[1]) && validOptionValue(set[2]))
              )
                throw new Error('Invalid core option command');
            }
            await rpc('send', command);
          },
          EmscriptenReceiveCommandReply: async () => (await rpc('receive')) as string | undefined,
          focus: async () => {
            // Offscreen frames can stop receiving animation frames in Chromium.
            // Bring the game back before waiting for a core-loop command/capture.
            frame.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            frame.focus();
            await rpc('focus');
          },
          captureScreenshot: async () => {
            const value = await rpc('screenshot');
            if (!(value instanceof ArrayBuffer)) throw new Error('Invalid screenshot reply');
            const bytes = new Uint8Array(value);
            pngInfo(bytes, SCREENSHOT_LIMIT);
            return bytes;
          },
          prepareStatePreview: async () => {
            const value = await rpc('preview-clear');
            if (typeof value !== 'boolean') throw new Error('Invalid preview capability');
            return value;
          },
          captureStatePreview: async () => {
            const value = await rpc('preview');
            if (value === null) return null;
            if (!(value instanceof ArrayBuffer)) throw new Error('Invalid preview reply');
            const bytes = new Uint8Array(value);
            pngInfo(bytes, PREVIEW_LIMIT);
            return bytes;
          },
          displayInfo: async () => {
            const value = (await rpc('display-info')) as DisplayInfo;
            if (
              !value ||
              !Number.isInteger(value.width) ||
              !Number.isInteger(value.height) ||
              value.width < 0 ||
              value.height < 0 ||
              value.width > 32768 ||
              value.height > 32768 ||
              typeof value.captureReady !== 'boolean' ||
              typeof value.preview !== 'boolean' ||
              !validDisplaySettings(value.settings)
            )
              throw new Error('Invalid display reply');
            return value;
          },
          setDisplay: async (settings) => {
            if (!validDisplaySettings(settings)) throw new Error('Invalid display settings');
            await rpc('display', settings);
          },
          settingsInfo: async () => {
            const info = (await rpc('settings-info')) as SettingsInfo;
            if (!info || typeof info.commands !== 'boolean' || typeof info.shaders !== 'boolean')
              throw new Error('Invalid settings capability');
            if (info.shaderResult !== undefined && !validShaderResult(info.shaderResult))
              throw new Error('Invalid shader status');
            return {
              commands: info.commands,
              shaders: info.shaders,
              ...(info.shaderResult ? { shaderResult: info.shaderResult } : {}),
            };
          },
          setShader: async (id) => {
            if (!validShaderId(id)) throw new Error('Invalid shader selection');
            const result = (await rpc('shader', id)) as ShaderResult;
            if (
              !validShaderResult(result) ||
              (result.status === 'requested' && result.selection !== id)
            )
              throw new Error('Invalid shader result');
            return { selection: result.selection, status: result.status };
          },
          inputInfo: async () => {
            const info = (await rpc('input-info')) as InputInfo;
            if (
              !info ||
              typeof info.supported !== 'boolean' ||
              typeof info.ready !== 'boolean' ||
              !Array.isArray(info.devices) ||
              info.devices.length > 16 ||
              !Array.isArray(info.assignments) ||
              info.assignments.length !== 4 ||
              info.assignments.some(
                (n) => n !== null && (!Number.isInteger(n) || n < 0 || n > 15),
              ) ||
              new Set(info.assignments.filter((n) => n !== null)).size !==
                info.assignments.filter((n) => n !== null).length ||
              !Array.isArray(info.states) ||
              info.states.length !== 4 ||
              info.states.some(
                (s) =>
                  !Number.isInteger(s.buttons) ||
                  s.buttons < 0 ||
                  s.buttons > 65535 ||
                  !Array.isArray(s.axes) ||
                  s.axes.length !== 4 ||
                  s.axes.some((n) => !Number.isFinite(n) || Math.abs(n) > 1),
              ) ||
              info.devices.some(
                (d) =>
                  !Number.isInteger(d.index) ||
                  d.index < 0 ||
                  d.index > 15 ||
                  typeof d.id !== 'string' ||
                  d.id.length > 180 ||
                  !['', 'standard'].includes(d.mapping) ||
                  !Number.isInteger(d.buttons) ||
                  d.buttons < 0 ||
                  d.buttons > 64 ||
                  !Number.isInteger(d.axes) ||
                  d.axes < 0 ||
                  d.axes > 16,
              ) ||
              (info.deviceError !== null &&
                (typeof info.deviceError !== 'string' || info.deviceError.length > 300))
            )
              throw Error('Invalid input information');
            if (info.capture !== null) {
              const c = info.capture;
              if (
                !c ||
                !['keyboard', 'mouse', 'controller'].includes(c.kind) ||
                (c.kind === 'keyboard' && !createInputEngine().validKey(c.key ?? '')) ||
                (c.kind === 'mouse' &&
                  (!Number.isInteger(c.mouse) || Number(c.mouse) < 0 || Number(c.mouse) > 6)) ||
                (c.kind === 'controller' &&
                  (!c.pad ||
                    !Number.isInteger(c.pad.index) ||
                    c.pad.index < 0 ||
                    c.pad.index > (c.pad.kind === 'button' ? 63 : 15) ||
                    !['button', 'axis'].includes(c.pad.kind) ||
                    (c.pad.kind === 'axis' && c.pad.direction !== -1 && c.pad.direction !== 1)))
              )
                throw Error('Invalid captured binding');
            }
            return info;
          },
          disableInput: async () => {
            await rpc('input-disable');
          },
          configureInput: async (map, assignments, assignmentPort = -1) => {
            createInputEngine().validateConfig(map);
            await rpc('input-config', { map, assignments, assignmentPort });
          },
          captureInput: async (request) => {
            await rpc('input-capture', request);
          },
          sendInput: (packet) => {
            if (closed || disposed) return;
            createInputEngine().packet(packet, 0);
            channel.port1.postMessage({ type: 'input', value: packet });
          },
        };
        return runtime;
      } catch (error) {
        close();
        throw error;
      }
    },
  };
};
