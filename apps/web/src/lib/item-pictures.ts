import { type ContentClient, ContentError, type ManifestFile } from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { imageType } from './previews.js';

export interface ItemPicturesState {
  /** Object URL for each picture file that could be read and is a real image. */
  urls: Record<string, string>;
  /** Files still being read. */
  pending: Record<string, true>;
}
export interface ItemPicturesController extends Readable<ItemPicturesState> {
  /** The picture files the game has now. Loaded ones are kept; ones that are gone are released. */
  show(files: ManifestFile[]): void;
  dispose(): void;
}
export interface ItemPicturesOptions {
  authorizationRejected?(status: 401 | 403): void;
}
/** A scanned page can be this large; anything bigger is downloaded, not shown. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Loads the pictures an uploaded game keeps as files, two at a time. A file is identified by
 * its id and content hash, so a replaced picture is read again and an unchanged one is not.
 */
export function createItemPictures(
  client: ContentClient,
  options: ItemPicturesOptions = {},
): ItemPicturesController {
  let current: ItemPicturesState = { urls: {}, pending: {} };
  const store = writable(current);
  const loaded = new Map<string, string>();
  let wanted = new Map<string, ManifestFile>();
  let queue: ManifestFile[] = [];
  let active = 0;
  let epoch = 0;
  let disposed = false;
  function update(patch: Partial<ItemPicturesState>) {
    current = { ...current, ...patch };
    store.set(current);
  }
  function settle(id: string, url?: string) {
    const { [id]: _done, ...pending } = current.pending;
    update(url ? { pending, urls: { ...current.urls, [id]: url } } : { pending });
  }
  function release(id: string) {
    loaded.delete(id);
    const url = current.urls[id];
    if (!url) return;
    URL.revokeObjectURL(url);
    const { [id]: _released, ...urls } = current.urls;
    update({ urls });
  }
  function clear() {
    epoch++;
    queue = [];
    wanted = new Map();
    for (const id of [...loaded.keys()]) release(id);
    for (const url of Object.values(current.urls)) URL.revokeObjectURL(url);
    update({ urls: {}, pending: {} });
  }
  function drain() {
    while (!disposed && active < 2 && queue.length) {
      const file = queue.shift();
      if (!file) break;
      const run = epoch;
      active++;
      void (async () => {
        try {
          const result = await client.collect(file.id, { maxBytes: MAX_BYTES });
          if (disposed || run !== epoch || wanted.get(file.id)?.sha256 !== file.sha256) return;
          const type = imageType(result.bytes);
          settle(
            file.id,
            type ? URL.createObjectURL(new Blob([result.bytes], { type })) : undefined,
          );
        } catch (error) {
          if (disposed || run !== epoch) return;
          if (error instanceof ContentError && (error.status === 401 || error.status === 403)) {
            const status = error.status;
            clear();
            options.authorizationRejected?.(status);
            return;
          }
          // An unreadable picture keeps its name tile; the file can still be downloaded.
          settle(file.id);
        } finally {
          active--;
          drain();
        }
      })();
    }
  }
  return {
    subscribe: store.subscribe,
    show(files) {
      if (disposed) return;
      wanted = new Map(files.map((file) => [file.id, file]));
      for (const id of [...loaded.keys()])
        if (wanted.get(id)?.sha256 !== loaded.get(id)) release(id);
      queue = queue.filter((file) => wanted.get(file.id)?.sha256 === file.sha256);
      const pending = { ...current.pending };
      for (const id of Object.keys(pending)) if (!wanted.has(id)) delete pending[id];
      for (const file of files) {
        if (loaded.get(file.id) === file.sha256 || file.size <= 0 || file.size > MAX_BYTES)
          continue;
        loaded.set(file.id, file.sha256);
        pending[file.id] = true;
        queue.push(file);
      }
      update({ pending });
      drain();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
    },
  };
}
