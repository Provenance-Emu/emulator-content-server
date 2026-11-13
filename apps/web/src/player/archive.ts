import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js/index-native.js';
import { type BrowserCore, contentExtensions } from './runtime.js';

const discExtension = /\.(cue|gdi|ccd|m3u)$/i;
export function archiveContentExtensions(core: BrowserCore): string[] {
  return contentExtensions(core).filter(
    (extension) =>
      ![
        'zip',
        '7z',
        'rar',
        'cue',
        'gdi',
        'ccd',
        'm3u',
        'chd',
        'iso',
        'cso',
        'rvz',
        'wia',
        'wbfs',
        'cdi',
      ].includes(extension),
  );
}
export function supportsContentName(core: BrowserCore, name: string): boolean {
  return (
    contentExtensions(core).some((extension) => name.toLowerCase().endsWith(`.${extension}`)) ||
    (/\.(zip|7z)$/i.test(name) && archiveContentExtensions(core).length > 0)
  );
}

/** Decompress in the browser. The original archive stays in the user's library. */
export async function extractPlayerZip(
  bytes: Uint8Array,
  extensions: string[],
  limit: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; extension: string }> {
  signal?.throwIfAborted();
  if (!bytes.length || bytes.length > limit)
    throw new Error('Archive exceeds this emulator’s size limit.');
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
    strictness: 'strict',
    checkSignature: true,
  });
  try {
    let count = 0;
    let selected: Awaited<ReturnType<typeof reader.getEntries>>[number] | undefined;
    for await (const entry of reader.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (++count > 512)
        throw new Error(
          'Archive has too many files. Extract the game before adding it to the library.',
        );
      if (entry.directory) continue;
      if (entry.filename.length > 1024 || entry.encrypted || entry.symlink)
        throw new Error('Encrypted or linked archive entries are unsupported.');
      if (discExtension.test(entry.filename))
        throw new Error('Extract this disc set and rescan its library folder to play it.');
      const extension = entry.filename.split('.').at(-1)?.toLowerCase();
      if (!extension || !extensions.includes(extension)) continue;
      if (selected)
        throw new Error(
          'This ZIP contains multiple game files. Extract and choose one game to play.',
        );
      if (
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize <= 0 ||
        entry.uncompressedSize > limit
      )
        throw new Error('Expanded game exceeds this emulator’s size limit.');
      selected = entry;
    }
    if (!selected || selected.directory)
      throw new Error('This ZIP contains no game file supported by the selected emulator.');
    const data = await selected.getData(new Uint8ArrayWriter(), {
      useWebWorkers: false,
      signal,
      checkSignature: true,
      onprogress(received) {
        if (received > limit) throw new Error('Expanded game exceeds this emulator’s size limit.');
      },
    });
    if (!data || data.length !== selected.uncompressedSize || data.length > limit)
      throw new Error('Expanded game size did not match the archive.');
    return {
      bytes: Uint8Array.from(data),
      extension: selected.filename.split('.').at(-1)?.toLowerCase() ?? '',
    };
  } finally {
    await reader.close();
  }
}

export function extractPlayerSevenZip(
  bytes: Uint8Array<ArrayBuffer>,
  extensions: string[],
  limit: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; extension: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./seven-zip-worker.ts', import.meta.url), {
      type: 'module',
    });
    const timeout = setTimeout(() => fail(new Error('7z extraction timed out.')), 60_000);
    function cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    }
    function fail(error: unknown) {
      cleanup();
      reject(error);
    }
    function abort() {
      fail(signal?.reason);
    }
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = () => fail(new Error('Unable to start 7z extraction.'));
    worker.onmessage = ({ data }) => {
      cleanup();
      if (data.error) reject(new Error(data.error));
      else resolve(data.result);
    };
    try {
      worker.postMessage([bytes, extensions, limit], [bytes.buffer]);
    } catch (error) {
      fail(error);
    }
  });
}
