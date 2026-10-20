import { type ContentClient, ContentError, type LibraryBrowseEntry } from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { entryKey } from './content-format.js';
export interface PreviewState {
  urls: Record<string, string>;
  loading: boolean;
}
export interface PreviewController extends Readable<PreviewState> {
  setPage(entries: LibraryBrowseEntry[]): Promise<void>;
  dispose(): void;
}
export interface PreviewOptions {
  authorizationRejected?(status: 401 | 403): void;
}
const MAX_BYTES = 2 * 1024 * 1024;

/** Derive MIME from a raster signature, never from its extension or a remote response header. */
function imageType(bytes: Uint8Array): string | null {
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
    finish(): void;
  }
  let queue: Work[] = [];
  function update(patch: Partial<PreviewState>) {
    current = { ...current, ...patch };
    store.set(current);
  }
  function clear() {
    epoch++;
    for (const work of queue) work.finish();
    queue = [];
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
          if (!id) return;
          const result = await client.collect(id, { maxBytes: MAX_BYTES });
          if (disposed || work.run !== epoch) return;
          const type = imageType(result.bytes);
          if (!type) return;
          const url = URL.createObjectURL(new Blob([result.bytes], { type }));
          update({ urls: { ...current.urls, [entryKey(work.entry)]: url } });
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
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
    },
  };
}
