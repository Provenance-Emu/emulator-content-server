import type { PlayerCoreDescriptor } from '@ecs/client';
import type { CommandRuntime } from './commands.js';
export interface PlayerRuntime extends CommandRuntime {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, bytes: Uint8Array): void;
    readFile(path: string): Uint8Array;
  };
  callMain(args: string[]): void;
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
) => Promise<{ factory: RuntimeFactory; release(): void }>;
export const paths = {
  config: '/ecs/retroarch.cfg',
  content: '/ecs/content/game.nes',
  battery_save: '/ecs/saves/game.srm',
  save_state: '/ecs/states/game.state',
} as const;
export function validateProfile(core: PlayerCoreDescriptor): void {
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
  core: PlayerCoreDescriptor,
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
    /\bimport\s*(?!\s*\.)|\b(?:Worker|SharedWorker)\s*\(|\b(?:audioWorklet|paintWorklet)\b|\bimportScripts\s*\(/.test(
      loader,
    )
  )
    throw new Error(
      'Unsupported build: imports, workers and worklets require a separately verified profile',
    );
}

export const importBrowserRuntime: RuntimeImporter = async (loader) => {
  const url = URL.createObjectURL(new Blob([loader], { type: 'text/javascript' }));
  try {
    const module = await import(/* @vite-ignore */ url);
    if (typeof module.default !== 'function')
      throw new Error('Unsupported core: an ES-module default factory is required');
    return { factory: module.default as RuntimeFactory, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
};
