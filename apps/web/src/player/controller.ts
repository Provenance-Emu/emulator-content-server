import type { ContentClient } from '@ecs/client';
import { CommandChannel } from './commands.js';
import { preparePlayer } from './preflight.js';
import { paths, type RuntimeImporter, validateCoreBytes } from './runtime.js';
import { SaveSynchronizer } from './saves.js';
export type PlayerSelection =
  | { kind: 'asset'; itemId: string; assetId: string }
  | { kind: 'source'; sourceId: string; itemId?: string };
export type PlayerClient = Pick<
  ContentClient,
  | 'capabilities'
  | 'playerCore'
  | 'playerCoreAssets'
  | 'libraries'
  | 'items'
  | 'sources'
  | 'manifest'
  | 'collect'
  | 'collectSource'
  | 'upload'
>;
export interface StartOptions {
  canvas: HTMLCanvasElement;
  importer: RuntimeImporter;
  batteryAssetId?: string;
  stateAssetId?: string;
  compatibleSaves?: boolean;
  log?: (text: string) => void;
}
const config = [
  'savefile_directory = "/ecs/saves"',
  'savestate_directory = "/ecs/states"',
  'system_directory = "/ecs/system"',
  'sort_savefiles_enable = "false"',
  'sort_savestates_enable = "false"',
  'sort_savefiles_by_content_enable = "false"',
  'sort_savestates_by_content_enable = "false"',
  'savefiles_in_content_dir = "false"',
  'savestates_in_content_dir = "false"',
  'savestate_auto_index = "false"',
  'savestate_auto_save = "false"',
  'savestate_auto_load = "false"',
  'config_save_on_exit = "false"',
  'state_slot = "0"',
].join('\n');

export async function startPlayer(
  client: PlayerClient,
  selection: PlayerSelection,
  options: StartOptions,
) {
  const prepared = await preparePlayer(client, selection, options);
  const assets = await client.playerCoreAssets(prepared.core.id);
  validateCoreBytes(prepared.core, assets);
  const loaded = await options.importer(assets.loader.bytes);
  try {
    const log = (text: string) => options.log?.(String(text).slice(0, 500));
    const runtime = await loaded.factory({
      wasmBinary: assets.wasm.bytes,
      canvas: options.canvas,
      noInitialRun: true,
      noExitRuntime: true,
      locateFile(path) {
        if (path === 'fceumm_libretro.wasm') return path;
        throw new Error(
          'Unsupported build: secondary worker/worklet/relative dependencies are forbidden',
        );
      },
      print: log,
      printErr: log,
    });
    const commands = new CommandChannel(runtime);
    if (
      typeof runtime.callMain !== 'function' ||
      !runtime.FS ||
      typeof runtime.FS.mkdirTree !== 'function' ||
      typeof runtime.FS.writeFile !== 'function' ||
      typeof runtime.FS.readFile !== 'function'
    )
      throw new Error('Unsupported core: MEMFS and callMain exports are required');
    for (const dir of ['/ecs', '/ecs/content', '/ecs/saves', '/ecs/states', '/ecs/system'])
      runtime.FS.mkdirTree(dir);
    runtime.FS.writeFile(paths.config, new TextEncoder().encode(config));
    runtime.FS.writeFile(paths.content, prepared.content);
    if (prepared.battery) runtime.FS.writeFile(paths.battery_save, prepared.battery.bytes);
    if (prepared.state) runtime.FS.writeFile(paths.save_state, prepared.state.bytes);
    runtime.callMain(['-c', paths.config, paths.content]);
    const saves =
      prepared.item && prepared.revision !== null
        ? new SaveSynchronizer(client, runtime, commands, {
            libraryId: prepared.item.libraryId,
            itemId: prepared.item.id,
            revision: prepared.revision,
            batteryPath: prepared.battery?.file.relativePath,
            statePath: prepared.state?.file.relativePath,
            selectedState: prepared.state?.bytes,
          })
        : null;
    if (prepared.state) await saves?.loadSelectedState();
    return { runtime, saves, prepared, releaseLoader: loaded.release };
  } catch (error) {
    loaded.release();
    throw error;
  }
}
