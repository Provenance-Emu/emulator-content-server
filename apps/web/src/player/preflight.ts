import type { Item, Manifest, ManifestFile } from '@ecs/client';
import type { PlayerClient, PlayerSelection, StartOptions } from './controller.js';
import {
  type BrowserCore,
  contentExtensions,
  profileIdentity,
  validateProfile,
} from './runtime.js';
import { stateCompatibility } from './states.js';
export const SAVE_LIMIT = 64 * 1024 * 1024;

export async function allItems(client: Pick<PlayerClient, 'libraries' | 'items'>): Promise<Item[]> {
  const items: Item[] = [];
  const libraryCursors = new Set<string>();
  let libraryCursor: string | undefined;
  do {
    const libraries = await client.libraries(libraryCursor);
    for (const library of libraries.items) {
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.items({ libraryId: library.id, limit: 100, cursor });
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error('Item listing did not advance');
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    libraryCursor = libraries.nextCursor ?? undefined;
    if (libraryCursor && libraryCursors.has(libraryCursor))
      throw new Error('Library listing did not advance');
    if (libraryCursor) libraryCursors.add(libraryCursor);
  } while (libraryCursor);
  return items;
}

function bounded(size: number, limit: number): void {
  if (!Number.isSafeInteger(size) || size <= 0 || size > limit)
    throw new Error('Content/save is empty or exceeds the supported size limit');
}
function selectedSave(
  manifest: Manifest | null,
  id: string | undefined,
  kind: string,
  compatible: boolean | undefined,
): ManifestFile | undefined {
  if (!id) return;
  if (!compatible)
    throw new Error('Confirm this save is compatible with the selected emulator build first');
  const file = manifest?.files.find((entry) => entry.id === id && entry.kind === kind);
  if (!file) throw new Error('The selected save does not belong to this target item');
  bounded(file.size, SAVE_LIMIT);
  return file;
}

export interface PreparedPlayer {
  core: BrowserCore;
  contentExtension: string;
  item: Item | null;
  revision: number | null;
  content: Uint8Array<ArrayBuffer>;
  battery?: { file: ManifestFile; bytes: Uint8Array<ArrayBuffer> };
  state?: { file: ManifestFile; bytes: Uint8Array<ArrayBuffer> };
}
export async function preparePlayer(
  client: PlayerClient,
  selection: PlayerSelection,
  options: StartOptions,
): Promise<PreparedPlayer> {
  if (!(await client.capabilities()).features.webPlayback)
    throw new Error(
      'Browser playback is unavailable. Ask the operator to configure an emulator profile.',
    );
  options.signal?.throwIfAborted();
  const core = options.profileId
    ? await client.playerProfile?.(options.profileId)
    : await client.playerCore();
  if (!core) throw new Error('Selected emulator profile is unavailable'); // Access gate before any operator code.
  validateProfile(core);
  if (options.expectedProfile && profileIdentity(options.expectedProfile) !== profileIdentity(core))
    throw new Error('Emulator profile changed; reload before starting');
  const item = selection.itemId
    ? (await allItems(client)).find((entry) => entry.id === selection.itemId)
    : null;
  if (selection.itemId && !item) throw new Error('Selected target item is unavailable');
  if (item && !core.systems.includes(item.systemIdentifier))
    throw new Error('Selected item system is not supported by this core');
  let manifest: Manifest | null = null;
  if (item) {
    manifest = await client.manifest(item.id);
    if (
      manifest.itemId !== item.id ||
      !Number.isSafeInteger(manifest.revision) ||
      manifest.revision < 1
    )
      throw new Error('Invalid target manifest');
  }
  let content: Uint8Array<ArrayBuffer>;
  let contentExtension = '';
  if (selection.kind === 'asset') {
    const file = manifest?.files.find(
      (entry) => entry.id === selection.assetId && entry.kind === 'rom',
    );
    if (
      !file ||
      !contentExtensions(core).some((extension) =>
        file.relativePath.toLowerCase().endsWith(`.${extension}`),
      )
    )
      throw new Error('Select a single-file ROM supported by this emulator');
    contentExtension = file.relativePath.split('.').at(-1)?.toLowerCase() ?? '';
    bounded(file.size, core.maxContentBytes);
    content = (
      await client.collect(file.id, { maxBytes: core.maxContentBytes, signal: options.signal })
    ).bytes;
  } else {
    const source = (await client.sources()).items.find((entry) => entry.id === selection.sourceId);
    if (source?.availability !== 'local')
      throw new Error(
        'Source is unavailable, offline, evicted or unknown. Download it on the server first.',
      );
    if (
      (source.groupFileCount ?? 1) > 1 ||
      source.kind !== 'rom' ||
      !contentExtensions(core).some((extension) =>
        source.name.toLowerCase().endsWith(`.${extension}`),
      ) ||
      !source.systemId ||
      !core.systems.includes(source.systemId)
    )
      throw new Error('Source is not a supported single-file ROM');
    if (
      item &&
      (!source.libraryId ||
        item.libraryId !== source.libraryId ||
        item.systemIdentifier !== source.systemId)
    )
      throw new Error('Select an explicit target in the source library and system');
    contentExtension = source.name.split('.').at(-1)?.toLowerCase() ?? '';
    bounded(source.size, core.maxContentBytes);
    content = (
      await client.collectSource(source.id, {
        maxBytes: core.maxContentBytes,
        signal: options.signal,
      })
    ).bytes;
  }
  bounded(content.byteLength, core.maxContentBytes);
  if (core.saveCompletion === 'none' && (options.batteryAssetId || options.stateAssetId))
    throw new Error('This emulator profile does not support save synchronization');
  options.signal?.throwIfAborted();
  const battery = selectedSave(
    manifest,
    options.batteryAssetId,
    'battery_save',
    options.compatibleSaves,
  );
  const state = selectedSave(manifest, options.stateAssetId, 'save_state', options.compatibleSaves);
  if (state && stateCompatibility(state.relativePath, core) === 'incompatible')
    throw new Error('State belongs to a different emulator build');
  async function collect(file: ManifestFile | undefined) {
    if (!file) return undefined;
    const bytes = (await client.collect(file.id, { maxBytes: SAVE_LIMIT, signal: options.signal }))
      .bytes;
    bounded(bytes.byteLength, SAVE_LIMIT);
    return { file, bytes };
  }
  return {
    core,
    contentExtension,
    item: item ?? null,
    revision: manifest?.revision ?? null,
    content,
    battery: await collect(battery),
    state: await collect(state),
  };
}
