import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { crc32 as chunkCrc32 } from 'node:zlib';
import { DomainError, isRomExtension } from '@ecs/domain';
import { crc32, fingerprintSingleZipEntry } from '@ecs/storage';
export async function boundedFile(path: string, max: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > max)
      throw new DomainError(
        'matching-file-too-large',
        413,
        'This file exceeds the matching read limit',
      );
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new DomainError(
        'matching-file-changed',
        409,
        'File changed; scan its folder and try again',
      );
    return buffer;
  } finally {
    await handle.close();
  }
}
export function imageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (
    bytes.length >= 16 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  )
    return 'image/webp';
  return null;
}

export interface RasterDescription {
  contentType: string;
  width: number;
  height: number;
}
/** Inspect bounded raster containers without allocating a decoded image on the HTTP process. */
export function describeRaster(bytes: Buffer): RasterDescription {
  const fail = (): never => {
    throw new DomainError(
      'unsupported-artwork',
      415,
      'Artwork must be a valid bounded PNG, JPEG or WebP raster',
    );
  };
  if (bytes.length > 2 * 1024 * 1024 || bytes.length < 12) fail();
  const type = imageType(bytes);
  let width = 0,
    height = 0;
  if (type === 'image/png') {
    let offset = 8,
      header = false,
      data = false,
      end = false;
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset);
      if (size > bytes.length - offset - 12) fail();
      const tag = bytes.toString('ascii', offset + 4, offset + 8);
      if (
        chunkCrc32(bytes.subarray(offset + 4, offset + 8 + size)) !==
        bytes.readUInt32BE(offset + 8 + size)
      )
        fail();
      if (!header && tag !== 'IHDR') fail();
      if (tag === 'IHDR') {
        if (header || size !== 13) fail();
        header = true;
        width = bytes.readUInt32BE(offset + 8);
        height = bytes.readUInt32BE(offset + 12);
        const depth = bytes[offset + 16],
          color = bytes[offset + 17];
        if (
          ![0, 2, 3, 4, 6].includes(color ?? -1) ||
          !([0, 3].includes(color ?? -1) ? [1, 2, 4, 8, 16] : [8, 16]).includes(depth ?? -1) ||
          (color === 3 && depth === 16) ||
          bytes[offset + 18] !== 0 ||
          bytes[offset + 19] !== 0 ||
          ![0, 1].includes(bytes[offset + 20] ?? -1)
        )
          fail();
      } else if (tag === 'IDAT') {
        if (!size) fail();
        data = true;
      } else if (tag === 'IEND') {
        if (size || !data || offset + 12 !== bytes.length) fail();
        end = true;
        break;
      } else if (tag === 'acTL' || tag === 'fcTL' || tag === 'fdAT') fail();
      offset += size + 12;
    }
    if (!header || !end) fail();
  } else if (type === 'image/jpeg') {
    if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) fail();
    let offset = 2,
      scan = false;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) fail();
      while (bytes[offset] === 0xff) offset++;
      const tag = bytes.readUInt8(offset++);
      if (tag === 0xda) {
        scan = true;
        break;
      }
      if (tag === 0xd8 || tag === 0xd9 || tag === 0 || tag === 1 || (tag >= 0xd0 && tag <= 0xd7))
        fail();
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) fail();
      if ([0xc0, 0xc1, 0xc2].includes(tag)) {
        if (width || length < 8) fail();
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
      }
      offset += length;
    }
    if (!scan) fail();
  } else if (type === 'image/webp') {
    let offset = 12,
      frame = false;
    while (offset + 8 <= bytes.length) {
      const tag = bytes.toString('ascii', offset, offset + 4),
        size = bytes.readUInt32LE(offset + 4),
        start = offset + 8;
      if (size > bytes.length - start) fail();
      if (tag === 'ANIM' || tag === 'ANMF') fail();
      if (tag === 'VP8X') {
        if (size !== 10 || width || ((bytes[start] ?? 0) & 2) !== 0) fail();
        width = 1 + bytes.readUIntLE(start + 4, 3);
        height = 1 + bytes.readUIntLE(start + 7, 3);
      } else if (tag === 'VP8 ') {
        if (frame || size < 10 || bytes.toString('hex', start + 3, start + 6) !== '9d012a') fail();
        frame = true;
        const w = bytes.readUInt16LE(start + 6) & 0x3fff,
          h = bytes.readUInt16LE(start + 8) & 0x3fff;
        if (width && (width !== w || height !== h)) fail();
        width = w;
        height = h;
      } else if (tag === 'VP8L') {
        if (frame || size < 5 || bytes[start] !== 0x2f) fail();
        frame = true;
        const bits = bytes.readUInt32LE(start + 1);
        if (bits >>> 29) fail();
        const w = 1 + (bits & 0x3fff),
          h = 1 + ((bits >>> 14) & 0x3fff);
        if (width && (width !== w || height !== h)) fail();
        width = w;
        height = h;
      }
      offset = start + size + (size % 2);
    }
    if (offset !== bytes.length || !frame) fail();
  } else fail();
  if (!width || !height || width > 16384 || height > 16384 || width * height > 40_000_000) fail();
  return { contentType: type as string, width, height };
}

/** Hash in small cancellable chunks; no full-ROM allocation on the HTTP event loop. */
export async function boundedFingerprint(
  path: string,
  max: number,
  signal?: AbortSignal,
): Promise<{ md5: string; crc32: string; size: number }> {
  signal?.throwIfAborted();
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(max))
      throw new DomainError(
        'matching-file-too-large',
        413,
        'This file exceeds the matching read limit',
      );
    const md5 = createHash('md5');
    let crc = 0xffffffff,
      size = 0;
    // Cancellation can arrive while open/stat await I/O. Do not construct a
    // ReadStream with an already-aborted signal before its iterator is attached.
    signal?.throwIfAborted();
    const stream = handle.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
      ...(signal ? { signal } : {}),
    });
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > max) {
        stream.destroy();
        throw new DomainError(
          'matching-file-too-large',
          413,
          'This file exceeds the matching read limit',
        );
      }
      md5.update(bytes);
      crc = crc32(bytes, crc);
    }
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(size) !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new DomainError(
        'matching-file-changed',
        409,
        'File changed; scan its folder and try again',
      );
    signal?.throwIfAborted();
    return {
      md5: md5.digest('hex'),
      crc32: ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0'),
      size,
    };
  } finally {
    await handle.close();
  }
}

const ZIP_MATCHING_QUOTA = {
  maxExpandedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxEntries: 256,
  maxNesting: 1,
  timeoutMs: 10000,
};
const ZIP_UNSUPPORTED_LAYOUT = /\.(zip|7z|rar|chd|cdi|iso|cue|m3u|gdi|ccd)$/i;
/** Hash exactly one raw cartridge/program; rejected archives retain filename hints. */
export async function boundedZipFingerprint(
  path: string,
  signal?: AbortSignal,
): Promise<{ md5: string; crc32: string; size: number } | null> {
  signal?.throwIfAborted();
  try {
    const fingerprint = await fingerprintSingleZipEntry(
      path,
      ZIP_MATCHING_QUOTA,
      (names) => {
        if (names.some((name) => ZIP_UNSUPPORTED_LAYOUT.test(name))) return null;
        const roms = names.filter((name) => isRomExtension(name));
        return roms.length === 1 ? (roms[0] ?? null) : null;
      },
      signal,
    );
    signal?.throwIfAborted();
    return fingerprint;
  } catch (error) {
    signal?.throwIfAborted();
    if (
      (error instanceof DomainError &&
        ['archive-rejected', 'unsupported-entry'].includes(error.code)) ||
      (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
    )
      return null;
    throw error;
  }
}
