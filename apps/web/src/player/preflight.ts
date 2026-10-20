import type { Item, Manifest, ManifestFile, PlayerCoreDescriptor } from '@ecs/client';
import type { PlayerClient, PlayerSelection, StartOptions } from './controller.js';
import { validateProfile } from './runtime.js';
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
    throw new Error('Confirm this save is compatible with the pinned FCEUmm build first');
  const file = manifest?.files.find((entry) => entry.id === id && entry.kind === kind);
  if (!file) throw new Error('The selected save does not belong to this target item');
  bounded(file.size, SAVE_LIMIT);
  return file;
}

export interface PreparedPlayer {
  core: PlayerCoreDescriptor;
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
    throw new Error('Browser playback is unavailable. Ask the operator to configure --player-dir.');
  const core = await client.playerCore(); // Access gate before any operator code.
  validateProfile(core);
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
  if (selection.kind === 'asset') {
    const file = manifest?.files.find(
      (entry) => entry.id === selection.assetId && entry.kind === 'rom',
    );
    if (!file?.relativePath.toLowerCase().endsWith('.nes'))
      throw new Error('Select a single-file NES ROM in this item');
    bounded(file.size, core.maxContentBytes);
    content = (await client.collect(file.id, { maxBytes: core.maxContentBytes })).bytes;
  } else {
    const source = (await client.sources()).items.find((entry) => entry.id === selection.sourceId);
    if (source?.availability !== 'local')
      throw new Error(
        'Source is unavailable, offline, evicted or unknown. Download it on the server first.',
      );
    if (
      source.kind !== 'rom' ||
      !source.name.toLowerCase().endsWith('.nes') ||
      !source.systemId ||
      !core.systems.includes(source.systemId)
    )
      throw new Error('Source is not a supported single-file NES ROM');
    if (
      item &&
      (!source.libraryId ||
        item.libraryId !== source.libraryId ||
        item.systemIdentifier !== source.systemId)
    )
      throw new Error('Select an explicit target in the source library and system');
    bounded(source.size, core.maxContentBytes);
    content = (await client.collectSource(source.id, { maxBytes: core.maxContentBytes })).bytes;
  }
  bounded(content.byteLength, core.maxContentBytes);
  const battery = selectedSave(
    manifest,
    options.batteryAssetId,
    'battery_save',
    options.compatibleSaves,
  );
  const state = selectedSave(manifest, options.stateAssetId, 'save_state', options.compatibleSaves);
  async function collect(file: ManifestFile | undefined) {
    if (!file) return undefined;
    const bytes = (await client.collect(file.id, { maxBytes: SAVE_LIMIT })).bytes;
    bounded(bytes.byteLength, SAVE_LIMIT);
    return { file, bytes };
  }
  return {
    core,
    item: item ?? null,
    revision: manifest?.revision ?? null,
    content,
    battery: await collect(battery),
    state: await collect(state),
  };
}
