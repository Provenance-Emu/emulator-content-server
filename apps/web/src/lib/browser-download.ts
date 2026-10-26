import type { DownloadSink } from '@ecs/client';

interface WritableFile {
  write(chunk: Uint8Array): Promise<void>;
  truncate(size: number): Promise<void>;
  seek(position: number): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
interface FileHandle {
  createWritable(): Promise<WritableFile>;
}
export interface BrowserDownloadTarget {
  createSink(): Promise<DownloadSink>;
}

/** Ask during the click gesture. Canceling is intentional; never start a fallback download. */
export async function chooseBrowserDownload(name: string): Promise<BrowserDownloadTarget | null> {
  const picker = (
    window as Window & {
      showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileHandle>;
    }
  ).showSaveFilePicker;
  if (typeof picker !== 'function') return null;
  const handle = await picker.call(window, { suggestedName: name });
  return {
    async createSink() {
      // The caller rechecks its library/authentication lifetime before opening the staging writer.
      // createWritable commits the chosen destination only when close succeeds; abort discards it.
      const writer = await handle.createWritable();
      return {
        write: (chunk) => writer.write(chunk),
        async reset() {
          await writer.truncate(0);
          await writer.seek(0);
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      };
    },
  };
}
