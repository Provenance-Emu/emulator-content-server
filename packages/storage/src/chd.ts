import { type FileHandle, open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  DomainError,
  type MaterializeQuota,
  type VirtualEntry,
  type VirtualWindow,
} from '@ecs/domain';

export const CHD_VERSION = 'chd-v1';
export const CHD_BUNDLE_ID = 'disc';
export interface ChdLayout {
  kind: 'dvd' | 'cd';
  entries: VirtualEntry[];
  cue?: string;
  totalSize: number;
}
const MODES: Record<string, { bytes: number; cue: string }> = {
  MODE1: { bytes: 2048, cue: 'MODE1/2048' },
  MODE1_RAW: { bytes: 2352, cue: 'MODE1/2352' },
  MODE2_RAW: { bytes: 2352, cue: 'MODE2/2352' },
  AUDIO: { bytes: 2352, cue: 'AUDIO' },
};
export function rejectChd(message: string): never {
  throw new DomainError('archive-rejected', 422, message);
}
function unsupported(message: string): never {
  throw new DomainError('unsupported-entry', 422, message);
}
function safe(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) rejectChd('CHD integer exceeds the safe range');
  return Number(value);
}
export function checkDeadline(deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted) rejectChd('CHD operation cancelled');
  if (performance.now() >= deadline) rejectChd('CHD operation timed out');
}
async function read(
  handle: FileHandle,
  size: number,
  position: number,
  fileSize: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(position + size) || position < 0 || position + size > fileSize)
    rejectChd('CHD metadata is outside the file');
  const bytes = Buffer.alloc(size);
  if ((await handle.read(bytes, 0, size, position)).bytesRead !== size)
    rejectChd('CHD file is truncated');
  return bytes;
}

// Header and metadata fields follow MAME src/lib/util/chd.h/chd.cpp (big endian).
// Only metadata is read here: codecs and maps belong to the configured decoder.
export async function inspectChd(
  filePath: string,
  quota: MaterializeQuota,
  window?: VirtualWindow,
  deadline = performance.now() + quota.timeoutMs,
  signal?: AbortSignal,
): Promise<ChdLayout | null> {
  const handle = await open(filePath, 'r');
  try {
    checkDeadline(deadline, signal);
    const fileSize = (await handle.stat()).size;
    const magic = await read(handle, Math.min(8, fileSize), 0, fileSize);
    if (magic.toString('ascii') !== 'MComprHD') return null;
    if (window) unsupported('Nested CHD windows are not supported');
    if (quota.maxNesting < 1) rejectChd('CHD exceeds the nesting quota');
    const header = await read(handle, 124, 0, fileSize);
    if (header.readUInt32BE(8) !== 124 || header.readUInt32BE(12) !== 5)
      unsupported('Only CHD v5 is supported');
    if (header.subarray(104, 124).some((byte) => byte !== 0))
      unsupported('Parent-dependent CHDs are not supported');
    const logical = safe(header.readBigUInt64BE(32));
    const map = safe(header.readBigUInt64BE(40));
    let offset = safe(header.readBigUInt64BE(48));
    const hunk = header.readUInt32BE(56);
    const unit = header.readUInt32BE(60);
    if (
      !logical ||
      !unit ||
      !hunk ||
      hunk > 524288 ||
      hunk % unit ||
      logical % unit ||
      Math.ceil(logical / hunk) > 0xffffffff ||
      map < 124 ||
      map >= fileSize
    )
      rejectChd('Invalid CHD sizes or map offset');
    const seen = new Set<number>();
    const intervals: [number, number][] = [];
    const tags = new Map<string, string[]>();
    let metadataBytes = 0;
    while (offset !== 0) {
      checkDeadline(deadline, signal);
      if (seen.has(offset) || seen.size >= 128 || offset < 124)
        rejectChd('CHD metadata chain is cyclic or excessive');
      seen.add(offset);
      const meta = await read(handle, 16, offset, fileSize);
      const length = meta.readUIntBE(5, 3);
      metadataBytes += length + 16;
      if (metadataBytes > 65536) rejectChd('CHD metadata exceeds 64 KiB');
      const end = offset + 16 + length;
      if (intervals.some(([start, stop]) => offset < stop && end > start))
        rejectChd('CHD metadata records overlap');
      intervals.push([offset, end]);
      const tag = meta.toString('ascii', 0, 4);
      const bytes = await read(handle, length, offset + 16, fileSize);
      // Disc declarations are ASCII C strings; reject hidden trailing fields.
      const text = bytes.toString('latin1').replace(/\0$/, '');
      const existing = tags.get(tag) ?? [];
      existing.push(text);
      tags.set(tag, existing);
      offset = safe(meta.readBigUInt64BE(8));
    }
    for (const tag of ['CHCD', 'CHTR', 'CHGT', 'CHGD', 'GDDD', 'AVAV', 'AVLD'])
      if (tags.has(tag)) unsupported('Unsupported CHD disc layout');
    const dvds = tags.get('DVD ') ?? [];
    const cds = tags.get('CHT2') ?? [];
    const sessions = tags.get('CHSE') ?? [];
    if (
      dvds.length > 1 ||
      (dvds.length && cds.length) ||
      sessions.length > 1 ||
      (sessions.length && sessions[0] !== 'SESSION:1')
    )
      unsupported('Conflicting or multisession CHD metadata');
    let kind: 'dvd' | 'cd';
    let cue: string | undefined;
    let sizes: [string, number][];
    if (dvds.length) {
      if (unit !== 2048 || logical % 2048 || sessions.length || dvds[0] !== '')
        unsupported('Unsupported DVD metadata or sector size');
      kind = 'dvd';
      sizes = [['disc.iso', logical]];
    } else if (cds.length) {
      if (unit !== 2448 || cds.length > 99)
        unsupported('Unsupported CD sector size or track count');
      kind = 'cd';
      cue = 'FILE "disc.bin" BINARY\n';
      let frames = 0;
      let binSize = 0;
      let padded = 0;
      for (const [index, text] of cds.entries()) {
        const fields =
          /^TRACK:(\d+) TYPE:([A-Z0-9_]+) SUBTYPE:([A-Z0-9_]+) FRAMES:(\d+) PREGAP:(\d+) PGTYPE:([A-Z0-9_]+) PGSUB:([A-Z0-9_]+) POSTGAP:(\d+)$/.exec(
            text,
          );
        if (!fields) unsupported('Unsupported CD track metadata');
        const number = Number(fields[1]);
        const mode = MODES[fields[2] ?? ''];
        const count = Number(fields[4]);
        if (
          number !== index + 1 ||
          !mode ||
          fields[3] !== 'NONE' ||
          fields[5] !== '0' ||
          fields[7] !== 'NONE' ||
          fields[8] !== '0'
        )
          unsupported('Unsupported CD tracks, gaps or subchannels');
        if (
          !Number.isSafeInteger(count) ||
          count <= 0 ||
          !Number.isSafeInteger(count * 2448) ||
          !Number.isSafeInteger(binSize + count * mode.bytes)
        )
          rejectChd('Unsafe CD frame count');
        const minutes = Math.floor(frames / 4500)
          .toString()
          .padStart(2, '0');
        const seconds = Math.floor((frames / 75) % 60)
          .toString()
          .padStart(2, '0');
        const remainder = (frames % 75).toString().padStart(2, '0');
        cue += `  TRACK ${String(number).padStart(2, '0')} ${mode.cue}\n    INDEX 01 ${minutes}:${seconds}:${remainder}\n`;
        frames += count;
        binSize += count * mode.bytes;
        padded += Math.ceil(count / 4) * 4 * 2448;
        if (!Number.isSafeInteger(padded)) rejectChd('Unsafe CD padding');
      }
      if (padded !== logical) rejectChd('CHD logical size conflicts with CD metadata');
      sizes = [
        ['disc.cue', Buffer.byteLength(cue)],
        ['disc.bin', binSize],
      ];
    } else unsupported('CHD has no supported disc metadata');
    const totalSize = sizes.reduce((sum, [, size]) => sum + size, 0);
    if (
      !Number.isSafeInteger(totalSize) ||
      totalSize > quota.maxExpandedBytes ||
      totalSize / fileSize > quota.maxCompressionRatio ||
      sizes.length > quota.maxEntries
    )
      rejectChd('CHD artifact group exceeds materialization quota');
    checkDeadline(deadline, signal);
    return {
      kind,
      ...(cue === undefined ? {} : { cue }),
      totalSize,
      // CD artifacts share the complete source size. These are not disjoint
      // compressed allocations and must not be summed as physical storage.
      entries: sizes.map(([path, uncompressedSize], index) => ({
        entryId: String(index),
        path,
        uncompressedSize,
        compressedSize: fileSize,
        method: kind === 'dvd' ? 'chd-dvd' : 'chd-cue-bin',
      })),
    };
  } finally {
    await handle.close();
  }
}
