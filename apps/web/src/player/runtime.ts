import type { PlayerCoreDescriptor, WebPlayerDescriptor } from '@ecs/client';
export type BrowserCore = PlayerCoreDescriptor | WebPlayerDescriptor;
export interface RuntimeContext {
  profile?: BrowserCore;
  assets?: { name: string; bytes: Uint8Array<ArrayBuffer> }[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

import type { CommandRuntime } from './commands.js';
export interface PlayerRuntime extends CommandRuntime {
  FS: {
    mkdirTree(path: string): void | Promise<void>;
    writeFile(path: string, bytes: Uint8Array): void | Promise<void>;
    readFile(path: string): Uint8Array | Promise<Uint8Array>;
  };
  callMain(args: string[]): void | Promise<void>;
  focus?(): void | Promise<void>;
  captureScreenshot?(): Promise<Uint8Array<ArrayBuffer>>;
  prepareStatePreview?(): Promise<boolean>;
  captureStatePreview?(): Promise<Uint8Array<ArrayBuffer> | null>;
  displayInfo?(): Promise<DisplayInfo>;
  setDisplay?(settings: DisplaySettings): Promise<void>;
}
export interface DisplaySettings {
  fit: 'contain' | 'fill';
  aspect: 'auto' | '4:3' | '16:9' | '1:1';
  filter: 'pixelated' | 'smooth';
}
export interface DisplayInfo {
  width: number;
  height: number;
  captureReady: boolean;
  preview: boolean;
  settings: DisplaySettings;
}
export function validDisplaySettings(value: unknown): value is DisplaySettings {
  if (!value || typeof value !== 'object') return false;
  const s = value as DisplaySettings;
  return (
    ['contain', 'fill'].includes(s.fit) &&
    ['auto', '4:3', '16:9', '1:1'].includes(s.aspect) &&
    ['pixelated', 'smooth'].includes(s.filter)
  );
}
export interface RuntimeOptions {
  wasmBinary: Uint8Array<ArrayBuffer>;
  noInitialRun: true;
  noExitRuntime: true;
  canvas: HTMLCanvasElement;
  locateFile(path: string): string;
  print(text: string): void;
  printErr(text: string): void;
}
export type RuntimeFactory = (options: RuntimeOptions) => Promise<PlayerRuntime>;
export type RuntimeImporter = (
  loader: Uint8Array<ArrayBuffer>,
  context?: RuntimeContext,
) => Promise<{ factory: RuntimeFactory; release(): void }>;
export const paths = {
  config: '/ecs/retroarch.cfg',
  content: '/ecs/content/game.nes',
  battery_save: '/ecs/saves/game.srm',
  save_state: '/ecs/states/game.state',
} as const;
export function contentExtensions(core: BrowserCore): string[] {
  return 'profileVersion' in core ? core.contentExtensions : [core.contentExtension];
}
export function profileIdentity(core: BrowserCore): string {
  return JSON.stringify([
    core.id,
    core.runtime,
    core.filesystem,
    core.threaded,
    core.saveCompletion,
    [...core.systems].sort(),
    [...contentExtensions(core)].sort(),
    core.maxContentBytes,
    core.loader.sha256,
    core.loader.sizeBytes,
    core.wasm.sha256,
    core.wasm.sizeBytes,
    'profileVersion' in core
      ? [
          core.buildVersion,
          ...core.assets.map((asset) => [asset.name, asset.sha256, asset.sizeBytes]).sort(),
        ]
      : [core.frontendCommit, core.coreCommit, core.emscriptenVersion],
  ]);
}
export function contentPath(core: BrowserCore, extension = contentExtensions(core)[0]): string {
  if (!extension || !contentExtensions(core).includes(extension))
    throw new Error('Unsupported content extension');
  return `/ecs/content/game.${extension}`;
}
export function validateProfile(core: BrowserCore): void {
  if ('profileVersion' in core) {
    if (
      core.profileVersion !== 1 ||
      !/^[a-z0-9][a-z0-9._-]{0,119}$/.test(core.id) ||
      !['emscripten-esm-v1', 'retroarch-emscripten-esm'].includes(core.runtime) ||
      core.threaded !== false ||
      core.filesystem !== 'memfs' ||
      !['none', 'command-reply-v1'].includes(core.saveCompletion) ||
      !Array.isArray(core.systems) ||
      !core.systems.length ||
      core.systems.length > 64 ||
      core.systems.some(
        (id) =>
          typeof id !== 'string' ||
          !/^[A-Za-z0-9]+(?:\.[A-Za-z0-9_-]+)+$/.test(id) ||
          id.length > 120,
      ) ||
      !Array.isArray(core.contentExtensions) ||
      !core.contentExtensions.length ||
      core.contentExtensions.length > 32 ||
      core.contentExtensions.some((extension) => !/^[a-z0-9]{1,16}$/.test(extension)) ||
      !Number.isSafeInteger(core.maxContentBytes) ||
      core.maxContentBytes < 1 ||
      core.maxContentBytes > 512 * 1024 * 1024 ||
      !Array.isArray(core.assets) ||
      core.assets.length > 16
    )
      throw new Error('Unsupported web player profile');
    return;
  }
  if (
    core.version !== 1 ||
    core.runtime !== 'retroarch-emscripten-esm' ||
    core.threaded ||
    core.filesystem !== 'memfs' ||
    core.saveCompletion !== 'command-reply-v1' ||
    core.contentExtension !== 'nes' ||
    core.emscriptenVersion !== '3.1.46' ||
    core.frontendCommit !== '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66' ||
    core.coreCommit !== 'ac0d00a7fc01166f84c7bac01d1084ebfd2b865e' ||
    core.systems.length !== 1 ||
    core.systems[0] !== 'com.provenance.nes' ||
    !Number.isSafeInteger(core.maxContentBytes) ||
    core.maxContentBytes <= 0 ||
    core.maxContentBytes > 64 * 1024 * 1024
  )
    throw new Error(
      'Unsupported core build/profile. Configure the pinned NES command-reply-v1 pair.',
    );
}

/** Trusted builds only. This rejects unsupported pair shapes; it is not a JS sandbox. */
export function validateCoreBytes(
  core: BrowserCore,
  assets: { loader: { bytes: Uint8Array }; wasm: { bytes: Uint8Array } },
): void {
  if (
    assets.loader.bytes.byteLength !== core.loader.sizeBytes ||
    assets.loader.bytes.byteLength === 0 ||
    assets.loader.bytes.byteLength > 8 * 1024 * 1024 ||
    assets.wasm.bytes.byteLength !== core.wasm.sizeBytes ||
    assets.wasm.bytes.byteLength > 64 * 1024 * 1024 ||
    ![0, 97, 115, 109, 1, 0, 0, 0].every((byte, index) => assets.wasm.bytes[index] === byte)
  )
    throw new Error('Invalid core artifact size or WASM header');
  const loader = new TextDecoder('utf-8', { fatal: true }).decode(assets.loader.bytes);
  if (
    /\bimport\b\s*(?!\s*\.)|\b(?:Worker|SharedWorker)\s*\(|\b(?:audioWorklet|paintWorklet)\b|\bimportScripts\s*\(/.test(
      loader,
    )
  )
    throw new Error(
      'Unsupported build: imports, workers and worklets require a separately verified profile',
    );
}

export { importIsolatedRuntime as importBrowserRuntime } from './sandbox.js';
