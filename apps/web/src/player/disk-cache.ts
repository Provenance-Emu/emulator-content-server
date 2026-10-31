import type { DownloadSink } from '@ecs/client';

export interface PlayerDiskFile {
  file: File;
  release(): Promise<void>;
}
export interface DiskCacheOptions {
  signal?: AbortSignal;
  /** Injection for focused filesystem tests; production uses this origin's private storage. */
  storage?: Pick<StorageManager, 'getDirectory' | 'estimate'>;
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
  const estimate = await storage.estimate();
  if (
    typeof estimate.quota === 'number' &&
    typeof estimate.usage === 'number' &&
    estimate.quota - estimate.usage < size + 16 * 1024 ** 2
  )
    throw new Error('Not enough private browser disk space for this disc. Free space and retry.');
  const directory = await (await storage.getDirectory()).getDirectoryHandle(
    'ecs-player-staging-v1',
    { create: true },
  );
  const name = `${crypto.randomUUID()}.disc`;
  const handle = await directory.getFileHandle(name, { create: true });
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
    await directory.removeEntry(name).catch(() => {});
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
    throw error;
  }
}
