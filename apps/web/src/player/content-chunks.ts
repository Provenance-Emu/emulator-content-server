import type { DownloadSink } from '@ecs/client';

/** The size of every piece but the last. The emulator frame checks the same number. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** Files this size and smaller are simply held as one buffer, as before. */
export const CHUNKED_FROM_BYTES = 64 * 1024 * 1024;
/**
 * The largest disc held in pieces. It is still all in memory, so this is about what a browser
 * can hold, not about the emulator: its own memory never contains the file.
 */
export const CHUNKED_CONTENT_LIMIT = 2 * 1024 ** 3;

/** One game file as separate pieces, never joined into a single buffer. */
export interface PlayerContentChunks {
  size: number;
  parts: Uint8Array<ArrayBuffer>[];
}

/**
 * Collects a download into pieces of `CHUNK_BYTES`. Each piece is its own buffer, so a disc
 * of a gigabyte never needs a gigabyte of contiguous memory, and each piece can be handed to
 * the emulator frame without being copied.
 */
export function chunkSink(size: number): { sink: DownloadSink; result(): PlayerContentChunks } {
  let parts: Uint8Array<ArrayBuffer>[] = [];
  let current: Uint8Array<ArrayBuffer> | null = null;
  let filled = 0;
  let received = 0;
  let closed = false;
  const next = () => {
    current = new Uint8Array(Math.min(CHUNK_BYTES, size - received));
    filled = 0;
  };
  return {
    sink: {
      async write(chunk) {
        if (closed) throw new Error('The download was already finished');
        if (received + chunk.byteLength > size)
          throw new Error('The server sent more than the file is said to hold');
        let taken = 0;
        while (taken < chunk.byteLength) {
          if (!current) next();
          const part = current as unknown as Uint8Array<ArrayBuffer>;
          const take = Math.min(chunk.byteLength - taken, part.byteLength - filled);
          part.set(chunk.subarray(taken, taken + take), filled);
          filled += take;
          taken += take;
          received += take;
          if (filled === part.byteLength) {
            parts.push(part);
            current = null;
          }
        }
      },
      async reset() {
        parts = [];
        current = null;
        filled = 0;
        received = 0;
        closed = false;
      },
      async close() {
        if (received !== size) throw new Error('The download ended before the whole file arrived');
        closed = true;
      },
      async abort() {
        parts = [];
        current = null;
      },
    },
    result() {
      if (!closed) throw new Error('The download has not finished');
      return { size, parts };
    },
  };
}

/** The emulators shown to read a disc by seeking in it, and the containers they read that way. */
export function readsInPieces(coreId: string, name: string): boolean {
  return (
    (coreId === 'org.flycast.wasm-jit' || coreId === 'org.flycast.shil-vm') &&
    /\.(chd|cdi)$/i.test(name)
  );
}

/** The largest file of this name the emulator can be given, whichever way it is held. */
export function contentLimit(core: { id: string; maxContentBytes: number }, name: string): number {
  return readsInPieces(core.id, name)
    ? Math.max(core.maxContentBytes, CHUNKED_CONTENT_LIMIT)
    : core.maxContentBytes;
}
