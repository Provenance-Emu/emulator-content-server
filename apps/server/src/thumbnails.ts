/**
 * Smaller copies of saved pictures for grids. Each is drawn once in a worker thread and kept in
 * `cache/thumbnails` under the data folder, named by the SHA-256 of the saved file, so it can be
 * deleted at any time and is never part of a backup's meaning.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ThumbnailReply, ThumbnailRequest } from './thumbnail-worker.js';

export const THUMBNAIL_WIDTHS = [240, 480, 960] as const;
export type ThumbnailWidth = (typeof THUMBNAIL_WIDTHS)[number];
export interface Thumbnail {
  bytes: Uint8Array;
  contentType: 'image/jpeg' | 'image/webp';
}
/**
 * A smaller copy; `as-saved` when this picture is always shown as it was saved (already narrow,
 * animated, or not something the server can redraw); or null when no copy could be made this
 * time, which says nothing about the next request.
 */
export type ThumbnailResult = Thumbnail | 'as-saved' | null;
export interface Thumbnails {
  get(sha256: string, width: ThumbnailWidth, original: () => Uint8Array): Promise<ThumbnailResult>;
  close(): Promise<void>;
}

/** Pixels a picture may hold before it is decoded: about 200 MB of memory while it is redrawn. */
const MAX_PIXELS = 50_000_000;
/** Each waiting picture holds its file in memory twice. */
const MAX_WAITING = 32;
/** After a picture this large the worker is replaced: its memory never shrinks by itself. */
const RECYCLE_PIXELS = 16_000_000;
const MAX_REFUSED = 4096;
const TYPES = { jpg: 'image/jpeg', webp: 'image/webp' } as const;

/** Width and height read from the file's header, without decoding it. */
export function pictureSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, text: string) =>
    bytes.length >= offset + text.length &&
    [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 'PNG') && ascii(12, 'IHDR'))
    return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xff) {
        offset++;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2);
      if (length < 2) return null;
      // Start-of-frame markers, except the tables that share their range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      offset += 2 + length;
    }
    return null;
  }
  if (bytes.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8X'))
      return {
        width: 1 + (view.getUint16(24, true) | ((bytes[26] ?? 0) << 16)),
        height: 1 + (view.getUint16(27, true) | ((bytes[29] ?? 0) << 16)),
      };
    if (ascii(12, 'VP8L') && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    if (ascii(12, 'VP8 ') && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
  }
  return null;
}

/** A picture with more than one frame. Only the first would survive being redrawn. */
export function animated(bytes: Uint8Array): boolean {
  const ascii = (offset: number, text: string) =>
    bytes.length >= offset + text.length &&
    [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP'))
    return ascii(12, 'VP8X') && ((bytes[20] ?? 0) & 2) !== 0;
  if (bytes[0] !== 0x89 || !ascii(1, 'PNG')) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // An animation is declared before the first image data.
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    if (ascii(offset + 4, 'acTL')) return true;
    if (ascii(offset + 4, 'IDAT')) return false;
    offset += 12 + view.getUint32(offset);
  }
  return false;
}

export function createThumbnails(dataDir: string): Thumbnails {
  const directory = join(dataDir, 'cache', 'thumbnails');
  const inFlight = new Map<string, Promise<ThumbnailResult>>();
  /** Pictures that are shown as saved, so they are not read and refused on every request. */
  const refused = new Set<string>();
  const waiting = new Map<number, (reply: ThumbnailReply) => void>();
  let worker: Worker | null = null;
  let next = 0;
  let closed = false;
  let recycle = false;

  function stopped(from: Worker) {
    if (worker !== from) return;
    worker = null;
    recycle = false;
    // Pictures that were only waiting are not blamed: they are drawn on a later request.
    for (const settle of waiting.values()) settle({ id: -1, bytes: null });
    waiting.clear();
  }
  const full = () => closed || waiting.size >= MAX_WAITING;
  function draw(bytes: Uint8Array, width: number): Promise<ThumbnailReply> {
    if (full()) return Promise.resolve({ id: -1, bytes: null });
    if (!worker) {
      const started = new Worker(new URL('./thumbnail-worker.js', import.meta.url), {
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      started.on('message', (reply: ThumbnailReply) => {
        const settle = waiting.get(reply.id);
        waiting.delete(reply.id);
        if (!waiting.size) started.unref();
        settle?.(reply);
        if ((reply.bytes === null && reply.broken) || (recycle && !waiting.size)) {
          stopped(started);
          void started.terminate();
        }
      });
      started.once('error', () => stopped(started));
      started.once('exit', () => stopped(started));
      worker = started;
    }
    const id = next++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      // Held only while a picture is being drawn: an idle worker never keeps the server running.
      worker?.ref();
      // A copy, handed over rather than copied again: the caller's bytes may be the catalog's own.
      const copy = new Uint8Array(bytes);
      worker?.postMessage({ id, bytes: copy, width } satisfies ThumbnailRequest, [copy.buffer]);
    });
  }
  async function read(key: string): Promise<Thumbnail | null> {
    for (const [extension, contentType] of Object.entries(TYPES) as [
      keyof typeof TYPES,
      Thumbnail['contentType'],
    ][]) {
      const bytes = await readFile(join(directory, `${key}.${extension}`)).catch(() => null);
      if (bytes?.length) return { bytes, contentType };
    }
    return null;
  }
  async function make(
    sha256: string,
    key: string,
    width: ThumbnailWidth,
    original: () => Uint8Array,
  ): Promise<ThumbnailResult> {
    const kept = await read(key);
    if (kept) return kept;
    // Before the file is read into memory: a burst of requests must not hold one each.
    if (full()) return null;
    const bytes = original();
    // The cover may have been replaced since its digest was read. A copy is only ever kept
    // under the digest of the file it was drawn from.
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) return null;
    const refuse = () => {
      if (refused.size >= MAX_REFUSED) refused.clear();
      refused.add(key);
      return 'as-saved' as const;
    };
    const size = pictureSize(bytes);
    if (!size || size.width < 1 || size.height < 1 || size.width * size.height > MAX_PIXELS)
      return refuse();
    if (size.width <= width || animated(bytes)) return refuse();
    if (size.width * size.height > RECYCLE_PIXELS) recycle = true;
    const reply = await draw(bytes, width);
    // Nothing is remembered when the queue was full, the worker stopped, or the server is stopping.
    if (!reply.bytes) return reply.id === -1 ? null : refuse();
    const extension = reply.contentType === 'image/webp' ? 'webp' : 'jpg';
    const target = join(directory, `${key}.${extension}`);
    const partial = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(partial, reply.bytes, { flag: 'wx' });
      await rename(partial, target);
    } catch {
      // The copy is still served; it is drawn again next time.
      await rm(partial, { force: true }).catch(() => undefined);
    }
    return { bytes: reply.bytes, contentType: reply.contentType };
  }
  return {
    get(sha256, width, original) {
      if (closed || !/^[0-9a-f]{64}$/.test(sha256) || !THUMBNAIL_WIDTHS.includes(width))
        return Promise.resolve(null);
      const key = `${sha256}-${width}`;
      if (refused.has(key)) return Promise.resolve('as-saved');
      const running = inFlight.get(key);
      if (running) return running;
      const result = make(sha256, key, width, original)
        .catch(() => null)
        .finally(() => inFlight.delete(key));
      inFlight.set(key, result);
      return result;
    },
    async close() {
      closed = true;
      const running = worker;
      if (running) {
        stopped(running);
        await running.terminate();
      }
    },
  };
}
