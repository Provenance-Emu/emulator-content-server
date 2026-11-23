import { type ContentClient, ContentError, type LibraryBrowseEntry } from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { entryKey } from './content-format.js';
export interface PreviewState {
  urls: Record<string, string>;
  loading: boolean;
}
export interface PreviewController extends Readable<PreviewState> {
  /** Replaces every cover with the ones for these entries. */
  setPage(entries: LibraryBrowseEntry[]): Promise<void>;
  /**
   * Adds covers for entries that have come on screen and keeps the ones already loaded. An
   * entry that was read again (a new object for the same key) has its cover fetched again
   * while the old one stays visible. The least recently requested covers are released.
   */
  request(entries: LibraryBrowseEntry[]): Promise<void>;
  dispose(): void;
}
export interface PreviewOptions {
  authorizationRejected?(status: 401 | 403): void;
}
const MAX_BYTES = 2 * 1024 * 1024;
/** Covers kept for a scrolling collection. Each is up to MAX_BYTES of image held in memory. */
const MAX_KEPT = 240;
/** Waiting cover reads. Older ones belong to cards that have scrolled away. */
const MAX_WAITING = 120;

/** Derive MIME from a raster signature, never from its extension or a remote response header. */
export function imageType(bytes: Uint8Array): string | null {
  const matches = (values: number[], offset = 0) =>
    values.every((value, i) => bytes[offset + i] === value);
  if (bytes.length >= 8 && matches([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (bytes.length >= 3 && matches([255, 216, 255])) return 'image/jpeg';
  if (
    bytes.length >= 16 &&
    matches([82, 73, 70, 70]) &&
    matches([87, 69, 66, 80], 8) &&
    matches([86, 80, 56], 12) &&
    [32, 76, 88].includes(bytes[15] ?? -1)
  ) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    if (size + 8 === bytes.length) return 'image/webp';
  }
  return null;
}

/** Keep this instance across page changes so old requests continue to occupy their four slots. */
export function createPreviews(
  client: ContentClient,
  options: PreviewOptions = {},
): PreviewController {
  let current: PreviewState = { urls: {}, loading: false };
  const store = writable(current);
  let epoch = 0;
  let disposed = false;
  let active = 0;
  interface Work {
    entry: LibraryBrowseEntry;
    run: number;
    /** Requested for a scrolling collection: tracked in `wanted` and released by age. */
    kept?: boolean;
    finish(): void;
  }
  let queue: Work[] = [];
  /** The entry each kept or wanted cover was read for, oldest request first. */
  const wanted = new Map<string, LibraryBrowseEntry>();
  function eligible(entry: LibraryBrowseEntry): boolean {
    if (entry.entityType === 'source') return entry.source?.artworkAvailable === true;
    const art = entry.previewAsset;
    return (
      entry.entityType === 'item' &&
      !!entry.item &&
      !!art &&
      art.itemId === entry.item.id &&
      art.kind === 'artwork' &&
      art.size > 0 &&
      art.size <= MAX_BYTES
    );
  }
  function release(key: string) {
    wanted.delete(key);
    const url = current.urls[key];
    if (!url) return;
    URL.revokeObjectURL(url);
    const { [key]: _released, ...urls } = current.urls;
    update({ urls });
  }
  function update(patch: Partial<PreviewState>) {
    current = { ...current, ...patch };
    store.set(current);
  }
  function clear() {
    epoch++;
    for (const work of queue) work.finish();
    queue = [];
    wanted.clear();
    for (const url of Object.values(current.urls)) URL.revokeObjectURL(url);
    update({ urls: {}, loading: false });
  }
  function drain() {
    while (!disposed && active < 4 && queue.length) {
      const work = queue.shift();
      if (!work) break;
      active++;
      void (async () => {
        try {
          const id = work.entry.previewAsset?.id;
          const result =
            work.entry.entityType === 'source' && work.entry.source?.artworkAvailable
              ? {
                  bytes: new Uint8Array(
                    await (
                      await client.selectedMatchContent(
                        work.entry.id,
                        'artwork',
                        undefined,
                        undefined,
                        work.entry.source.artworkVersion,
                      )
                    ).arrayBuffer(),
                  ),
                }
              : id
                ? await client.collect(id, {
                    maxBytes: MAX_BYTES,
                    version: work.entry.previewAsset?.sha256,
                  })
                : null;
          if (disposed || work.run !== epoch) return;
          const key = entryKey(work.entry);
          // A newer read of the same game owns this cover now.
          if (work.kept && wanted.get(key) !== work.entry) return;
          const type = result ? imageType(result.bytes) : null;
          const previous = current.urls[key];
          if (!result || !type) {
            if (work.kept && previous) {
              URL.revokeObjectURL(previous);
              const { [key]: _gone, ...urls } = current.urls;
              update({ urls });
            }
            return;
          }
          const url = URL.createObjectURL(new Blob([result.bytes], { type }));
          if (previous) URL.revokeObjectURL(previous);
          update({ urls: { ...current.urls, [key]: url } });
        } catch (error) {
          if (
            !disposed &&
            work.run === epoch &&
            error instanceof ContentError &&
            (error.status === 401 || error.status === 403)
          ) {
            const rejectedEpoch = epoch + 1;
            clear();
            if (!disposed && epoch === rejectedEpoch) options.authorizationRejected?.(error.status);
          }
          // Unavailable/oversized/unsupported images retain the title/system fallback.
        } finally {
          active--;
          work.finish();
          drain();
        }
      })();
    }
  }
  return {
    subscribe: store.subscribe,
    setPage(entries) {
      if (disposed) return Promise.resolve();
      clear();
      const run = epoch;
      const seen = new Set<string>();
      const eligible = entries.filter((entry) => {
        const art = entry.previewAsset;
        const key = entryKey(entry);
        if (entry.entityType === 'source' && entry.source?.artworkAvailable && !seen.has(key)) {
          seen.add(key);
          return true;
        }
        if (
          seen.has(key) ||
          entry.entityType !== 'item' ||
          !entry.item ||
          !art ||
          art.itemId !== entry.item.id ||
          art.kind !== 'artwork' ||
          art.size <= 0 ||
          art.size > MAX_BYTES
        )
          return false;
        seen.add(key);
        return true;
      });
      let remaining = eligible.length;
      update({ loading: remaining > 0 });
      const results = eligible.map(
        (entry) =>
          new Promise<void>((resolve) => {
            queue.push({
              entry,
              run,
              finish() {
                remaining--;
                if (!disposed && run === epoch && remaining === 0) update({ loading: false });
                resolve();
              },
            });
          }),
      );
      drain();
      return Promise.all(results).then(() => undefined);
    },
    request(entries) {
      if (disposed) return Promise.resolve();
      const run = epoch;
      const added: Promise<void>[] = [];
      const works: Work[] = [];
      for (const entry of entries) {
        const key = entryKey(entry);
        if (!eligible(entry)) {
          if (wanted.has(key)) release(key);
          continue;
        }
        const same = wanted.get(key) === entry;
        // Re-inserting moves the key to the newest end of the release order.
        wanted.delete(key);
        wanted.set(key, entry);
        if (same) continue;
        added.push(
          new Promise<void>((resolve) => {
            works.push({ entry, run, kept: true, finish: resolve });
          }),
        );
      }
      // The newest request is what the viewer is looking at, so it goes first.
      queue = [...works, ...queue];
      for (const dropped of queue.splice(MAX_WAITING)) {
        if (wanted.get(entryKey(dropped.entry)) === dropped.entry) release(entryKey(dropped.entry));
        dropped.finish();
      }
      for (const key of wanted.keys()) {
        if (wanted.size <= MAX_KEPT) break;
        release(key);
      }
      drain();
      return Promise.all(added).then(() => undefined);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
    },
  };
}
