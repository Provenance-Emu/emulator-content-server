import {
  type Asset,
  type ContentClient,
  ContentError,
  type Item,
  type LibraryBrowseEntry,
  type Manifest,
  type ManifestFile,
  type SourceFile,
  type SourceGroupFile,
} from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { explain } from './problems.js';
export interface DetailDownload {
  bytes: Uint8Array<ArrayBuffer>;
  name: string;
}
export interface DetailState {
  entry: LibraryBrowseEntry | null;
  item: Item | null;
  asset: Asset | null;
  source: SourceFile | null;
  sourceFiles: SourceGroupFile[];
  groupError: string | null;
  manifest: Manifest | null;
  files: ManifestFile[];
  revision: number | null;
  canUpload: boolean;
  canAdopt: boolean;
  loading: boolean;
  reading: { id: string; received: number; total: number | null } | null;
  adopting: boolean;
  failure: string | null;
  status: number | null;
}
export interface DetailController extends Readable<DetailState> {
  load(): Promise<void>;
  download(file?: ManifestFile): Promise<DetailDownload | null>;
  downloadMember(id: string): Promise<DetailDownload | null>;
  downloadBundle(): Promise<Response | null>;
  adopt(): Promise<Asset | null>;
  dispose(): void;
}
const empty = (): DetailState => ({
  entry: null,
  item: null,
  asset: null,
  source: null,
  sourceFiles: [],
  groupError: null,
  manifest: null,
  files: [],
  revision: null,
  canUpload: false,
  canAdopt: false,
  loading: false,
  reading: null,
  adopting: false,
  failure: null,
  status: null,
});

/** One opened identity. Recreate from a refreshed browse entry when its flags/metadata change. */
export function createDetail(client: ContentClient, entry: LibraryBrowseEntry): DetailController {
  let current = empty();
  const store = writable(current);
  let epoch = 0;
  let disposed = false;
  let sourceDenied = false;
  let pending: Promise<void> | null = null;
  let bundleAbort: AbortController | null = null;
  const live = (run: number) => !disposed && run === epoch;
  function update(patch: Partial<DetailState>) {
    current = { ...current, ...patch };
    store.set(current);
  }
  function failure(error: unknown) {
    const status = error instanceof ContentError ? error.status : null;
    if (status === 401 || status === 403 || status === 404) {
      sourceDenied = entry.entityType === 'source';
      update(empty());
    }
    update({ failure: explain(error), status });
  }
  async function read(run: number) {
    if (!live(run)) return;
    if (entry.entityType === 'source' && entry.source) {
      const group =
        (entry.source.groupFileCount ?? 0) > 1 || entry.source.groupError
          ? await client.sourceGroup(entry.id)
          : null;
      if (live(run))
        update({
          entry,
          source: entry.source,
          sourceFiles: group?.files ?? [],
          groupError: group?.error ?? entry.source.groupError ?? null,
          failure: null,
          status: null,
        });
      return;
    }
    let selected: Asset | null = null;
    if (entry.entityType === 'asset' && entry.asset) {
      selected = await client.asset(entry.id);
      if (!live(run)) return;
      if (selected.id !== entry.id || selected.itemId !== entry.asset.itemId)
        throw new Error('Invalid selected file');
    }
    const originalItem = entry.item ?? entry.parentItem;
    if (!originalItem) throw new Error('This entry has no managed item');
    const manifest = await client.manifest(originalItem.id);
    if (!live(run)) return;
    if (
      manifest.itemId !== originalItem.id ||
      !Number.isSafeInteger(manifest.revision) ||
      manifest.revision < 1
    )
      throw new Error('Invalid item manifest');
    const item = { ...originalItem, revision: manifest.revision };
    const refreshed = {
      ...entry,
      ...(entry.entityType === 'item'
        ? { item }
        : { parentItem: item, asset: selected ?? undefined }),
    };
    update({
      entry: refreshed,
      item,
      asset: selected,
      manifest,
      files: manifest.files,
      revision: manifest.revision,
      canUpload: entry.canUpload,
      canAdopt:
        entry.canAdopt &&
        !!selected?.conflictOf &&
        (selected.kind === 'battery_save' || selected.kind === 'save_state'),
      failure: null,
      status: null,
    });
  }
  async function downloadFile(
    file?: ManifestFile,
    memberId?: string,
  ): Promise<DetailDownload | null> {
    if (disposed || !current.entry || current.loading || current.reading || current.adopting)
      return null;
    const source = memberId
      ? current.sourceFiles.find((file) => file.id === memberId)
      : current.source;
    if (memberId && !source) return null;
    const selected = source
      ? null
      : current.files.find((row) => row.id === (file?.id ?? current.asset?.id));
    if (source ? source.availability !== 'local' : !selected) return null;
    const id = source?.id ?? selected?.id;
    if (!id) return null;
    const run = epoch;
    update({
      reading: { id, received: 0, total: source?.size ?? selected?.size ?? null },
      failure: null,
      status: null,
    });
    try {
      const options = {
        onProgress(received: number, total: number | null) {
          if (live(run)) update({ reading: { id, received, total } });
        },
      };
      const result = source
        ? await client.collectSource(id, options)
        : await client.collect(id, options);
      if (!live(run)) return null;
      return {
        bytes: result.bytes,
        name: source?.name ?? selected?.relativePath.split('/').at(-1) ?? id,
      };
    } catch (error) {
      if (live(run)) failure(error);
      return null;
    } finally {
      if (live(run)) update({ reading: null });
    }
  }
  return {
    subscribe: store.subscribe,
    load() {
      if (disposed || sourceDenied || current.adopting || current.reading) return Promise.resolve();
      if (pending) return pending;
      const run = ++epoch;
      update({ loading: true, reading: null, failure: null, status: null });
      // Defer execution once so even source-only loads share/clear the same pending promise.
      pending = Promise.resolve()
        .then(() => read(run))
        .catch((error) => {
          if (live(run)) failure(error);
        })
        .finally(() => {
          if (live(run)) {
            pending = null;
            update({ loading: false });
          }
        });
      return pending;
    },
    download: downloadFile,
    downloadMember(id) {
      return downloadFile(undefined, id);
    },
    async downloadBundle() {
      if (
        disposed ||
        !current.source ||
        current.sourceFiles.length < 2 ||
        current.groupError ||
        current.loading ||
        current.reading
      )
        return null;
      const run = epoch;
      bundleAbort?.abort();
      bundleAbort = new AbortController();
      update({ reading: { id: 'bundle', received: 0, total: null }, failure: null });
      try {
        const response = await client.sourceBundle(current.source.id, bundleAbort.signal);
        return live(run) ? response : null;
      } catch (error) {
        if (live(run)) failure(error);
        return null;
      } finally {
        if (live(run)) update({ reading: null });
      }
    },
    async adopt() {
      if (
        disposed ||
        !current.canAdopt ||
        !current.asset ||
        current.loading ||
        current.reading ||
        current.adopting
      )
        return null;
      const id = current.asset.id;
      const run = ++epoch;
      update({ adopting: true, failure: null, status: null });
      try {
        const result = await client.adopt(id);
        if (!live(run)) return null;
        // The old item revision cannot authorize another upload after a successful mutation.
        update({
          canUpload: false,
          canAdopt: false,
          revision: null,
          item: null,
          manifest: null,
          files: [],
          asset: result,
        });
        // A successful mutation still invalidates its collection if the subsequent read fails.
        try {
          await read(run);
        } catch (error) {
          if (live(run)) failure(error);
        }
        return live(run) ? result : null;
      } catch (error) {
        if (live(run)) failure(error);
        return null;
      } finally {
        if (live(run)) update({ adopting: false });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      bundleAbort?.abort();
      epoch++;
      pending = null;
      update(empty());
    },
  };
}
