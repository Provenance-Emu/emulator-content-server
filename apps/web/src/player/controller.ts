import { type CollectedAsset, type ContentClient, sha256Bytes } from '@ecs/client';
import { CommandChannel } from './commands.js';
import type { cachePlayerDisk } from './disk-cache.js';
import { nativeInputConfig, verifiedInputBuild } from './input-model.js';
import { coreOptionsConfig } from './options.js';
import type { PlayerPreferences } from './preferences.js';
import { preparePlayer } from './preflight.js';
import { contentPath, paths, type RuntimeImporter, validateCoreBytes } from './runtime.js';
import { SaveSynchronizer } from './saves.js';
export type PlayerSelection =
  | { kind: 'asset'; itemId: string; assetId: string }
  | { kind: 'source'; sourceId: string; itemId?: string };
export type PlayerClient = Partial<
  Pick<
    ContentClient,
    | 'playerProfile'
    | 'playerProfiles'
    | 'playerProfileAssets'
    | 'sourceGroup'
    | 'downloadTo'
    | 'downloadSourceTo'
    | 'createPlayerIsolation'
    | 'closePlayerIsolation'
  >
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
  stageDisk?: typeof cachePlayerDisk;
  expectedProfile?: import('./runtime.js').BrowserCore;
  profileId?: string;
  signal?: AbortSignal;
  canvas: HTMLCanvasElement;
  importer: RuntimeImporter;
  batteryAssetId?: string;
  stateAssetId?: string;
  compatibleSaves?: boolean;
  log?: (text: string) => void;
  preferences?: PlayerPreferences;
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
  'core_options_path = "/ecs/core-options.cfg"',
  'video_shader_enable = "false"',
  'suspend_screensaver_enable = "false"',
].join('\n');

export async function startPlayer(
  client: PlayerClient,
  selection: PlayerSelection,
  options: StartOptions,
) {
  const prepared = await preparePlayer(client, selection, options);
  let loaded: Awaited<ReturnType<RuntimeImporter>> | undefined;
  try {
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
    const createIsolation = client.createPlayerIsolation?.bind(client);
    const closeIsolation = client.closePlayerIsolation?.bind(client);
    loaded = await options.importer(assets.loader.bytes, {
      profile: prepared.core,
      assets: extra,
      signal: options.signal,
      inputEnabled: verifiedInputBuild(prepared.core),
      ...(createIsolation && closeIsolation
        ? {
            isolation: {
              create: createIsolation,
              close: closeIsolation,
            },
          }
        : {}),
    });
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
    const settingsInfo = await runtime.settingsInfo?.();
    const commands =
      prepared.core.saveCompletion === 'command-reply-v1' || settingsInfo?.commands
        ? new CommandChannel(runtime)
        : null;
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
    const systemDirectory =
      'profileVersion' in prepared.core && prepared.core.systemFilesDirectory
        ? `/ecs/system/${prepared.core.systemFilesDirectory}`
        : '/ecs/system';
    if (extra.length && systemDirectory !== '/ecs/system')
      await runtime.FS.mkdirTree(systemDirectory);
    for (const asset of extra) {
      await runtime.FS.writeFile(`${systemDirectory}/${asset.name}`, asset.bytes);
      if (prepared.core.id === 'org.libretro.parallel-dc' && asset.name === 'awbios.zip') {
        await runtime.FS.mkdirTree('/ecs/system/dc');
        await runtime.FS.writeFile('/ecs/system/dc/awbios.zip', asset.bytes);
      }
    }
    await runtime.FS.writeFile(
      paths.config,
      new TextEncoder().encode(
        config + (verifiedInputBuild(prepared.core) ? `\n${nativeInputConfig()}` : ''),
      ),
    );
    await runtime.FS.writeFile(
      '/ecs/core-options.cfg',
      new TextEncoder().encode(coreOptionsConfig(options.preferences?.options ?? {})),
    );
    for (const file of prepared.contentFiles ?? [])
      await runtime.FS.writeFile(file.path, file.bytes);
    if (prepared.disk) {
      if (!runtime.mountContentFile)
        throw new Error('This runtime cannot mount a disk-backed disc');
      await runtime.mountContentFile(
        contentPath(prepared.core, prepared.contentExtension),
        prepared.disk.file,
      );
    } else
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
      commands &&
      prepared.core.saveCompletion === 'command-reply-v1' &&
      prepared.item &&
      prepared.revision !== null
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
    const release = loaded.release;
    return {
      runtime,
      commands,
      saves,
      prepared,
      releaseLoader() {
        release();
        void prepared.disk?.release();
      },
    };
  } catch (error) {
    loaded?.release();
    await prepared.disk?.release();
    throw error;
  }
}
