import type { DownloadSink } from '@ecs/client';

export interface PlayerDiskFile {
  file: File;
  release(): Promise<void>;
}
export interface DiskCacheOptions {
  signal?: AbortSignal;
  /** Injection for focused filesystem tests; production uses this origin's private storage. */
  storage?: Pick<StorageManager, 'getDirectory' | 'estimate'>;
  locks?: Pick<LockManager, 'request'>;
}

/** Version-two cache entries are always protected by these origin-scoped lifetime locks. */
const cacheLock = (name: string) => `ecs-player-disc:${name}`;
export async function reclaimPlayerDiscs(
  directory: FileSystemDirectoryHandle,
  locks?: Pick<LockManager, 'request'>,
): Promise<void> {
  if (!locks) return; // Never infer liveness without the browser's cross-tab lock service.
  const entries = (
    directory as unknown as { entries?(): AsyncIterable<[string, { kind: string }]> }
  ).entries?.();
  if (!entries) return;
  let seen = 0;
  for await (const [name, handle] of entries) {
    if (++seen > 64) break;
    if (
      handle.kind !== 'file' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.disc$/.test(name)
    )
      continue;
    await locks.request(cacheLock(name), { ifAvailable: true }, async (lock) => {
      if (lock) await directory.removeEntry(name).catch(() => {});
    });
  }
}
async function holdDisc(
  locks: Pick<LockManager, 'request'> | undefined,
  name: string,
): Promise<() => Promise<void>> {
  if (!locks) return async () => {};
  let unlock = () => {};
  let acquired!: () => void, failed!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    acquired = resolve;
    failed = reject;
  });
  const held = locks.request(cacheLock(name), async () => {
    const lifetime = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    acquired();
    await lifetime;
  });
  void held.catch(failed);
  await ready;
  return async () => {
    unlock();
    await held;
  };
}

/** Stage with backpressure on browser disk, never an array of disc-sized memory chunks. */
export async function cachePlayerDisk(
  size: number,
  download: (sink: DownloadSink) => Promise<void>,
  options: DiskCacheOptions = {},
): Promise<PlayerDiskFile> {
  if (!Number.isSafeInteger(size) || size < 1 || size > 9 * 1024 ** 3)
    throw new Error('Disc exceeds the supported 9 GiB file limit');
  const storage = options.storage ?? globalThis.navigator?.storage;
  if (!storage?.getDirectory)
    throw new Error(
      'Large discs need private browser disk storage. Use a supported local browser.',
    );
  options.signal?.throwIfAborted();
  const locks = options.locks ?? globalThis.navigator?.locks;
  // A new namespace avoids deleting pre-lock cache entries owned by older running players.
  const directory = await (await storage.getDirectory()).getDirectoryHandle(
    locks ? 'ecs-player-staging-v2' : 'ecs-player-staging-unlocked',
    { create: true },
  );
  await reclaimPlayerDiscs(directory, locks);
  const estimate = await storage.estimate();
  if (
    typeof estimate.quota === 'number' &&
    typeof estimate.usage === 'number' &&
    estimate.quota - estimate.usage < size + 16 * 1024 ** 2
  )
    throw new Error('Not enough private browser disk space for this disc. Free space and retry.');
  const name = `${crypto.randomUUID()}.disc`;
  const unlock = await holdDisc(locks, name);
  let handle: FileSystemFileHandle;
  try {
    handle = await directory.getFileHandle(name, { create: true });
  } catch (error) {
    await unlock();
    throw error;
  }
  let writer: FileSystemWritableFileStream | undefined;
  let received = 0,
    committed = false,
    released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      await writer?.abort();
    } catch {
      /* Already committed or aborted. */
    }
    writer = undefined;
    try {
      await directory.removeEntry(name).catch(() => {});
    } finally {
      await unlock();
    }
  };
  const sink: DownloadSink = {
    async reset() {
      if (released) throw new Error('Disc staging was closed');
      options.signal?.throwIfAborted();
      if (!writer) writer = await handle.createWritable();
      await writer.truncate(0);
      await writer.seek(0);
      received = 0;
    },
    async write(chunk) {
      options.signal?.throwIfAborted();
      if (!writer || released || chunk.byteLength > size - received)
        throw new Error('Disc stream exceeds its selected file size');
      // The client already limits writes to 64 KiB; copy only the current view for DOM type safety.
      for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) {
        const part = new Uint8Array(chunk.subarray(offset, offset + 64 * 1024));
        await writer.write(part);
      }
      received += chunk.byteLength;
    },
    async close() {
      options.signal?.throwIfAborted();
      if (!writer || received !== size || released)
        throw new Error('Disc staging ended before the complete file');
      await writer.close();
      writer = undefined;
      committed = true;
    },
    async abort() {
      await release();
    },
  };
  try {
    await download(sink);
    options.signal?.throwIfAborted();
    if (!committed || received !== size)
      throw new Error('Disc download did not commit a complete representation');
    const file = await handle.getFile();
    if (file.size !== size) throw new Error('Staged disc size changed');
    return { file, release };
  } catch (error) {
    await release();
    if (
      error &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'QuotaExceededError'
    )
      throw new Error(
        'The browser ran out of disk storage while preparing this disc. Free disk space and retry.',
      );
    throw error;
  }
}
