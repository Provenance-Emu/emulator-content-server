import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
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
