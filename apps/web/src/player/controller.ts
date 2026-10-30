import { type CollectedAsset, type ContentClient, sha256Bytes } from '@ecs/client';
import { CommandChannel } from './commands.js';
import { preparePlayer } from './preflight.js';
import { contentPath, paths, type RuntimeImporter, validateCoreBytes } from './runtime.js';
import { SaveSynchronizer } from './saves.js';
export type PlayerSelection =
  | { kind: 'asset'; itemId: string; assetId: string }
  | { kind: 'source'; sourceId: string; itemId?: string };
export type PlayerClient = Partial<
  Pick<ContentClient, 'playerProfile' | 'playerProfiles' | 'playerProfileAssets' | 'sourceGroup'>
> &
  Pick<
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
  expectedProfile?: import('./runtime.js').BrowserCore;
  profileId?: string;
  signal?: AbortSignal;
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
  'savestate_thumbnail_enable = "true"',
].join('\n');

export async function startPlayer(
  client: PlayerClient,
  selection: PlayerSelection,
  options: StartOptions,
) {
  const prepared = await preparePlayer(client, selection, options);
  const assets:
    | {
        loader: CollectedAsset;
        wasm: CollectedAsset;
        assets?: { name: string; bytes: Uint8Array<ArrayBuffer> }[];
      }
    | undefined =
    'profileVersion' in prepared.core
      ? await client.playerProfileAssets?.(prepared.core.id)
      : await client.playerCoreAssets(prepared.core.id);
  if (!assets) throw new Error('Selected emulator resources are unavailable');
  options.signal?.throwIfAborted();
  const extra = assets.assets ?? [];
  if ('profileVersion' in prepared.core) {
    if (
      (await sha256Bytes(assets.loader.bytes)) !== prepared.core.loader.sha256 ||
      (await sha256Bytes(assets.wasm.bytes)) !== prepared.core.wasm.sha256 ||
      extra.length !== prepared.core.assets.length
    )
      throw new Error('Emulator profile changed; reload before starting');
    for (const spec of prepared.core.assets) {
      const file = extra.find((asset) => asset.name === spec.name);
      if (
        !file ||
        file.bytes.byteLength !== spec.sizeBytes ||
        (await sha256Bytes(file.bytes)) !== spec.sha256
      )
        throw new Error('Emulator resource changed; reload before starting');
    }
  }
  validateCoreBytes(prepared.core, assets);
  const loaded = await options.importer(assets.loader.bytes, {
    profile: prepared.core,
    assets: extra,
    signal: options.signal,
  });
  try {
    const log = (text: string) => options.log?.(String(text).slice(0, 500));
    const runtime = await loaded.factory({
      wasmBinary: assets.wasm.bytes,
      canvas: options.canvas,
      noInitialRun: true,
      noExitRuntime: true,
      locateFile(path) {
        if (
          path === 'fceumm_libretro.wasm' ||
          ('profileVersion' in prepared.core &&
            (/^[a-zA-Z0-9_.-]+\.wasm$/.test(path) || extra.some((asset) => asset.name === path)))
        )
          return path;
        throw new Error(
          'Unsupported build: secondary worker/worklet/relative dependencies are forbidden',
        );
      },
      print: log,
      printErr: log,
    });
    const commands =
      prepared.core.saveCompletion === 'command-reply-v1' ? new CommandChannel(runtime) : null;
    if (
      typeof runtime.callMain !== 'function' ||
      !runtime.FS ||
      typeof runtime.FS.mkdirTree !== 'function' ||
      typeof runtime.FS.writeFile !== 'function' ||
      typeof runtime.FS.readFile !== 'function'
    )
      throw new Error('Unsupported core: MEMFS and callMain exports are required');
    for (const dir of ['/ecs', '/ecs/content', '/ecs/saves', '/ecs/states', '/ecs/system'])
      await runtime.FS.mkdirTree(dir);
    for (const asset of extra) {
      await runtime.FS.writeFile(`/ecs/system/${asset.name}`, asset.bytes);
      if (prepared.core.id === 'org.libretro.parallel-dc' && asset.name === 'awbios.zip') {
        await runtime.FS.mkdirTree('/ecs/system/dc');
        await runtime.FS.writeFile('/ecs/system/dc/awbios.zip', asset.bytes);
      }
    }
    await runtime.FS.writeFile(paths.config, new TextEncoder().encode(config));
    for (const file of prepared.contentFiles ?? [])
      await runtime.FS.writeFile(file.path, file.bytes);
    await runtime.FS.writeFile(
      contentPath(prepared.core, prepared.contentExtension),
      prepared.content,
    );
    if (prepared.battery) await runtime.FS.writeFile(paths.battery_save, prepared.battery.bytes);
    if (prepared.state) await runtime.FS.writeFile(paths.save_state, prepared.state.bytes);
    options.signal?.throwIfAborted();
    await runtime.callMain(
      prepared.core.runtime === 'retroarch-emscripten-esm'
        ? ['-c', paths.config, contentPath(prepared.core, prepared.contentExtension)]
        : [contentPath(prepared.core, prepared.contentExtension)],
    );
    const saves =
      commands && prepared.item && prepared.revision !== null
        ? new SaveSynchronizer(client, runtime, commands, {
            libraryId: prepared.item.libraryId,
            itemId: prepared.item.id,
            revision: prepared.revision,
            core: prepared.core,
            profileId: prepared.core.id,
            coreName: prepared.core.name,
            buildVersion:
              'profileVersion' in prepared.core
                ? prepared.core.buildVersion
                : 'FCEUmm ac0d00a7 / RetroArch 4d4bfc0f',
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
