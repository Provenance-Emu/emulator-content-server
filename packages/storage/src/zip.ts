import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, open, stat } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import {
  DomainError,
  type MaterializeQuota,
  type VirtualContentProvider,
  type VirtualEntry,
  type VirtualResolution,
  type VirtualWindow,
} from '@ecs/domain';
import { crc32 } from './hash.js';

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_FIXED_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_FIXED_SIZE = 56;
const ZIP64_EXTRA_ID = 0x0001;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_FIXED_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_FIXED_SIZE = 30;
const UINT16_SENTINEL = 0xffff;
const UINT32_SENTINEL = 0xffffffff;
const MAX_COMMENT_BYTES = 0xffff;
const MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024;
const FLAG_ENCRYPTED = 0x0001;
const UNSUPPORTED_FINGERPRINT_FLAGS = FLAG_ENCRYPTED | 0x40 | 0x2000;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const ENTRY_ID = /^\d{1,10}(\.\d{1,10}){0,3}$/;

// A high ratio on a small entry is ordinary compression, so the ratio limit only
// applies once an entry is large enough for the expansion to matter.
const RATIO_FLOOR_BYTES = 64 * 1024;

interface CentralRecord {
  index: number;
  name: string;
  flags: number;
  method: number;
  unixMode: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** Exclusive bound within this archive window. */
  dataEnd: number;
}

interface Budget {
  entries: number;
  expanded: number;
}

type Walk =
  | { kind: 'found'; window: VirtualWindow; record: CentralRecord; path: string }
  | { kind: 'blocked'; entryId: string; remainder: string | null; path: string };

export class ZipProvider implements VirtualContentProvider {
  readonly format = 'zip';

  async inspect(
    filePath: string,
    quota: MaterializeQuota,
    window?: VirtualWindow,
  ): Promise<{ entries: VirtualEntry[] } | null> {
    return withArchive(filePath, window, async (handle, root) => {
      const budget: Budget = { entries: quota.maxEntries, expanded: quota.maxExpandedBytes };
      const entries = await collectEntries(handle, root, quota, budget, '', '', 1);
      return entries === null ? null : { entries };
    });
  }

  async resolve(
    filePath: string,
    entryId: string,
    quota: MaterializeQuota,
  ): Promise<VirtualResolution | null> {
    if (!ENTRY_ID.test(entryId)) return null;
    return withArchive(filePath, undefined, async (handle, root) => {
      const found = await walk(handle, root, entryId, quota);
      if (!found) return null;
      if (found.kind === 'blocked') {
        return {
          kind: 'expand',
          entryId: found.entryId,
          remainder: found.remainder,
          path: found.path,
        };
      }
      const { record, window } = found;
      if (record.method !== METHOD_STORE || isEncrypted(record)) {
        return { kind: 'expand', entryId, remainder: null, path: found.path };
      }
      const start = await dataOffset(handle, window, record);
      return {
        kind: 'range',
        entry: toEntry(record, entryId, found.path),
        offset: window.offset + start,
      };
    });
  }

  async materialize(
    filePath: string,
    entryId: string,
    destination: string,
    quota: MaterializeQuota,
  ): Promise<{ sha256: string; size: number }> {
    const expanded = ENTRY_ID.test(entryId)
      ? await withArchive(filePath, undefined, async (handle, root) => {
          const found = await walk(handle, root, entryId, quota);
          if (!found || found.kind === 'blocked') return null;
          const { record, window } = found;
          if (isEncrypted(record)) {
            throw new DomainError(
              'unsupported-entry',
              422,
              'Encrypted archive entries are not served',
            );
          }
          if (record.method !== METHOD_DEFLATE) {
            throw new DomainError(
              'unsupported-entry',
              422,
              `Archive entries stored as ${methodName(record.method)} are not served`,
            );
          }
          const start = await dataOffset(handle, window, record);
          return inflateEntry(filePath, window.offset + start, record, destination, quota);
        })
      : null;
    if (!expanded) throw new DomainError('not-found', 404, 'Archive entry not found');
    return expanded;
  }
}

export interface ZipEntryFingerprint {
  md5: string;
  crc32: string;
  size: number;
}

/** Hash one selected member without extraction or nested expansion. The caller supplies
 * a bounded archive-wide selection policy; container CRCs never become content hashes. */
export async function fingerprintSingleZipEntry(
  filePath: string,
  quota: MaterializeQuota,
  selectName: (names: readonly string[]) => string | null,
  signal?: AbortSignal,
): Promise<ZipEntryFingerprint | null> {
  signal?.throwIfAborted();
  const limited = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(quota.timeoutMs),
  ]);
  return withArchive(filePath, undefined, async (handle, root) => {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(quota.maxExpandedBytes))
      reject('Archive exceeds the matching read limit');
    limited.throwIfAborted();
    const records = await readCentralDirectory(handle, root, quota, 1024 * 1024);
    limited.throwIfAborted();
    if (!records) return null;
    const selected = selectName(records.map((record) => record.name));
    const candidates = records.filter((record) => record.name === selected);
    if (
      candidates.length !== 1 ||
      records.some(
        (record) =>
          (record.flags & UNSUPPORTED_FINGERPRINT_FLAGS) !== 0 ||
          ![METHOD_STORE, METHOD_DEFLATE].includes(record.method),
      )
    )
      return null;
    const record = candidates[0];
    if (!record || record.uncompressedSize === 0 || ![0, 0x8000].includes(record.unixMode & 0xf000))
      return null;
    checkEntryLimits(record, quota);
    const start = await dataOffset(handle, root, record);
    const header = await readAt(handle, root, record.localHeaderOffset, LOCAL_FIXED_SIZE);
    if ((header.readUInt16LE(6) & UNSUPPORTED_FINGERPRINT_FLAGS) !== 0)
      reject('Encrypted archive entries are not fingerprinted');
    const localName = await readAt(
      handle,
      root,
      record.localHeaderOffset + LOCAL_FIXED_SIZE,
      header.readUInt16LE(26),
    );
    if (localName.toString('utf8') !== record.name)
      reject('Archive local name disagrees with the central directory');
    limited.throwIfAborted();
    const md5 = createHash('md5');
    let crc = 0xffffffff,
      size = 0;
    const sink = new Writable({
      highWaterMark: 64 * 1024,
      write(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > Math.min(record.uncompressedSize, quota.maxExpandedBytes)) {
          callback(
            new DomainError(
              'archive-rejected',
              422,
              'Archive entry expands past its declared size',
            ),
          );
          return;
        }
        md5.update(bytes);
        crc = crc32(bytes, crc);
        callback();
      },
    });
    const source = handle.createReadStream({
      start: root.offset + start,
      end: root.offset + start + record.compressedSize - 1,
      autoClose: false,
      highWaterMark: 64 * 1024,
    });
    const inflate =
      record.method === METHOD_DEFLATE ? createInflateRaw({ chunkSize: 64 * 1024 }) : null;
    try {
      if (inflate) await pipeline(source, inflate, sink, { signal: limited });
      else await pipeline(source, sink, { signal: limited });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'Z_DATA_ERROR' || error.code === 'Z_BUF_ERROR')
      )
        reject('Archive entry contains invalid DEFLATE data');
      throw error;
    }
    limited.throwIfAborted();
    if (inflate && inflate.bytesWritten !== record.compressedSize)
      reject('Archive entry contains trailing bytes after its DEFLATE stream');
    if (size !== record.uncompressedSize)
      reject('Archive entry did not expand to its declared size');
    const checksum = (crc ^ 0xffffffff) >>> 0;
    if (checksum !== record.crc) reject('Archive entry failed its CRC check');
    const after = await handle.stat({ bigint: true });
    let current = after;
    try {
      current = await stat(filePath, { bigint: true });
    } catch {
      throw new DomainError('archive-changed', 409, 'Archive changed while reading its member');
    }
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size ||
      current.mtimeNs !== before.mtimeNs ||
      current.ctimeNs !== before.ctimeNs
    )
      throw new DomainError('archive-changed', 409, 'Archive changed while reading its member');
    limited.throwIfAborted();
    return { md5: md5.digest('hex'), crc32: checksum.toString(16).padStart(8, '0'), size };
  });
}

function toEntry(record: CentralRecord, entryId: string, path: string): VirtualEntry {
  return {
    entryId,
    path,
    compressedSize: record.compressedSize,
    uncompressedSize: record.uncompressedSize,
    method: methodName(record.method),
    crc: record.crc.toString(16).padStart(8, '0'),
  };
}

// Every path that can reach an entry has to apply these, because a client may
// ask for an entry by id without ever listing the archive.
function checkEntryLimits(record: CentralRecord, quota: MaterializeQuota): void {
  if (
    record.uncompressedSize >= RATIO_FLOOR_BYTES &&
    record.uncompressedSize / record.compressedSize > quota.maxCompressionRatio
  ) {
    reject('Archive entry exceeds the allowed compression ratio');
  }
  if (record.uncompressedSize > quota.maxExpandedBytes) {
    reject('Archive entry expands past the allowed total size');
  }
}

function isEncrypted(record: CentralRecord): boolean {
  return (record.flags & FLAG_ENCRYPTED) !== 0;
}

function methodName(method: number): string {
  if (method === METHOD_STORE) return 'store';
  if (method === METHOD_DEFLATE) return 'deflate';
  return `method-${method}`;
}

function reject(message: string): never {
  throw new DomainError('archive-rejected', 422, message);
}

async function withArchive<T>(
  filePath: string,
  window: VirtualWindow | undefined,
  use: (handle: FileHandle, root: VirtualWindow) => Promise<T | null>,
): Promise<T | null> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (window && window.offset + window.length > size) {
      reject('Archive window falls outside the file');
    }
    return await use(handle, window ?? { offset: 0, length: size });
  } finally {
    await handle.close();
  }
}

// Positions are relative to the start of the archive, which is not the start of
// the file when the archive is a stored entry of an outer container.
async function readAt(
  handle: FileHandle,
  window: VirtualWindow,
  position: number,
  length: number,
): Promise<Buffer> {
  if (position < 0 || position + length > window.length) {
    reject('Archive ends before a structure it declares');
  }
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, window.offset + position);
  if (bytesRead !== length) reject('Archive ends before a structure it declares');
  return buffer;
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) reject(`${label} is too large to address`);
  return Number(value);
}

interface EndRecord {
  totalEntries: number;
  directorySize: number;
  directoryOffset: number;
  directoryLimit: number;
}

async function readEndRecord(handle: FileHandle, window: VirtualWindow): Promise<EndRecord | null> {
  if (window.length < EOCD_FIXED_SIZE) return null;
  const tailLength = Math.min(window.length, MAX_COMMENT_BYTES + EOCD_FIXED_SIZE);
  const tail = await readAt(handle, window, window.length - tailLength, tailLength);
  for (let offset = tail.length - EOCD_FIXED_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    if (offset + EOCD_FIXED_SIZE + tail.readUInt16LE(offset + 20) !== tail.length) continue;
    if (
      tail.readUInt16LE(offset + 4) !== 0 ||
      tail.readUInt16LE(offset + 6) !== 0 ||
      tail.readUInt16LE(offset + 8) !== tail.readUInt16LE(offset + 10)
    ) {
      reject('Split-volume archives are not supported');
    }
    const end = {
      totalEntries: tail.readUInt16LE(offset + 10),
      directorySize: tail.readUInt32LE(offset + 12),
      directoryOffset: tail.readUInt32LE(offset + 16),
      directoryLimit: window.length - tailLength + offset,
    };
    const zip64 =
      end.totalEntries === UINT16_SENTINEL ||
      end.directorySize === UINT32_SENTINEL ||
      end.directoryOffset === UINT32_SENTINEL;
    if (!zip64) return end;
    return readZip64EndRecord(handle, window, window.length - tailLength + offset);
  }
  return null;
}

async function readZip64EndRecord(
  handle: FileHandle,
  window: VirtualWindow,
  endOffset: number,
): Promise<EndRecord> {
  const locatorOffset = endOffset - ZIP64_LOCATOR_SIZE;
  if (locatorOffset < 0) reject('Archive claims ZIP64 without a locator');
  const locator = await readAt(handle, window, locatorOffset, ZIP64_LOCATOR_SIZE);
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) {
    reject('Archive claims ZIP64 without a locator');
  }
  if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
    reject('Split-volume ZIP64 archives are not supported');
  }
  const recordOffset = safeNumber(locator.readBigUInt64LE(8), 'ZIP64 end record offset');
  if (recordOffset > locatorOffset - ZIP64_EOCD_FIXED_SIZE) {
    reject('Archive ZIP64 end record overlaps its locator');
  }
  const record = await readAt(handle, window, recordOffset, ZIP64_EOCD_FIXED_SIZE);
  if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE)
    reject('Archive ZIP64 end record is missing');
  const recordSize = record.readBigUInt64LE(4);
  if (recordSize < 44n || BigInt(recordOffset) + 12n + recordSize !== BigInt(locatorOffset)) {
    reject('Archive ZIP64 end record length is inconsistent with its locator');
  }
  if (
    record.readUInt32LE(16) !== 0 ||
    record.readUInt32LE(20) !== 0 ||
    record.readBigUInt64LE(24) !== record.readBigUInt64LE(32)
  ) {
    reject('Split-volume ZIP64 archives are not supported');
  }
  return {
    totalEntries: safeNumber(record.readBigUInt64LE(32), 'Archive entry count'),
    directorySize: safeNumber(record.readBigUInt64LE(40), 'Central directory size'),
    directoryOffset: safeNumber(record.readBigUInt64LE(48), 'Central directory offset'),
    directoryLimit: recordOffset,
  };
}

async function readCentralDirectory(
  handle: FileHandle,
  window: VirtualWindow,
  quota: MaterializeQuota,
  maxDirectoryBytes = MAX_CENTRAL_DIRECTORY_BYTES,
): Promise<CentralRecord[] | null> {
  const end = await readEndRecord(handle, window);
  if (!end) return null;
  if (end.totalEntries > quota.maxEntries) {
    reject('Archive declares more entries than the quota allows');
  }
  if (end.directorySize > maxDirectoryBytes) {
    reject('Archive central directory is too large to parse');
  }
  if (end.directoryOffset + end.directorySize > end.directoryLimit) {
    reject('Archive central directory overlaps its end records');
  }
  const directory = await readAt(handle, window, end.directoryOffset, end.directorySize);
  const records: CentralRecord[] = [];
  const memberOffsets: number[] = [];
  let cursor = 0;
  for (let index = 0; index < end.totalEntries; index += 1) {
    if (cursor + CENTRAL_FIXED_SIZE > directory.length) reject('Archive central directory is torn');
    if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      reject('Archive central directory is malformed');
    }
    if (directory.readUInt16LE(cursor + 34) !== 0) {
      reject('Archive member refers to another volume');
    }
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const nameAt = cursor + CENTRAL_FIXED_SIZE;
    const extraAt = nameAt + nameLength;
    const next = extraAt + extraLength + commentLength;
    if (next > directory.length) reject('Archive central directory is torn');
    const record: CentralRecord = {
      index,
      name: directory.toString('utf8', nameAt, extraAt),
      flags: directory.readUInt16LE(cursor + 8),
      method: directory.readUInt16LE(cursor + 10),
      unixMode: directory.readUInt32LE(cursor + 38) >>> 16,
      crc: directory.readUInt32LE(cursor + 16),
      compressedSize: directory.readUInt32LE(cursor + 20),
      uncompressedSize: directory.readUInt32LE(cursor + 24),
      localHeaderOffset: directory.readUInt32LE(cursor + 42),
      dataEnd: end.directoryOffset,
    };
    applyZip64Extra(record, directory.subarray(extraAt, extraAt + extraLength));
    cursor = next;
    if (isUnsafeName(record.name)) reject('Archive entry name escapes its own tree');
    if (record.localHeaderOffset >= end.directoryOffset) {
      reject('Archive entry header falls outside the member data area');
    }
    memberOffsets.push(record.localHeaderOffset);
    if (record.name.endsWith('/')) continue;
    if (record.compressedSize === 0 && record.uncompressedSize > 0) {
      reject('Archive entry declares expansion from no compressed bytes');
    }
    if (
      record.method === METHOD_STORE &&
      !isEncrypted(record) &&
      record.compressedSize !== record.uncompressedSize
    ) {
      reject('Stored archive entry sizes do not match');
    }
    records.push(record);
  }
  const orderedOffsets = [...new Set(memberOffsets)].sort((a, b) => a - b);
  const bounds = new Map(
    orderedOffsets.map((offset, index) => [
      offset,
      orderedOffsets[index + 1] ?? end.directoryOffset,
    ]),
  );
  for (const record of records) {
    record.dataEnd = bounds.get(record.localHeaderOffset) ?? end.directoryOffset;
  }
  return records;
}

// A stored container expands at a ratio of exactly one, so nesting cannot
// amplify a bomb and the per-entry ratio limit is already the cumulative limit.
async function collectEntries(
  handle: FileHandle,
  window: VirtualWindow,
  quota: MaterializeQuota,
  budget: Budget,
  idPrefix: string,
  pathPrefix: string,
  depth: number,
): Promise<VirtualEntry[] | null> {
  const records = await readCentralDirectory(handle, window, quota);
  if (!records) return null;
  const entries: VirtualEntry[] = [];
  for (const record of records) {
    const entryId = idPrefix === '' ? String(record.index) : `${idPrefix}.${record.index}`;
    const path = `${pathPrefix}${record.name}`;
    const children = await collectChildren(
      handle,
      window,
      quota,
      budget,
      record,
      entryId,
      path,
      depth,
    );
    if (children) {
      entries.push(...children);
      continue;
    }
    if (budget.entries <= 0) reject('Archive declares more entries than the quota allows');
    budget.entries -= 1;
    checkEntryLimits(record, quota);
    budget.expanded -= record.uncompressedSize;
    if (budget.expanded < 0) reject('Archive expands past the allowed total size');
    entries.push(toEntry(record, entryId, path));
  }
  return entries;
}

async function collectChildren(
  handle: FileHandle,
  window: VirtualWindow,
  quota: MaterializeQuota,
  budget: Budget,
  record: CentralRecord,
  entryId: string,
  path: string,
  depth: number,
): Promise<VirtualEntry[] | null> {
  if (depth >= quota.maxNesting) return null;
  if (record.method !== METHOD_STORE || isEncrypted(record)) return null;
  if (record.compressedSize < EOCD_FIXED_SIZE) return null;
  const start = await dataOffset(handle, window, record);
  const child = { offset: window.offset + start, length: record.compressedSize };
  if (!(await looksLikeArchive(handle, child))) return null;
  return collectEntries(handle, child, quota, budget, entryId, `${path}/`, depth + 1);
}

// A four byte prefix check keeps the cost of probing every stored member
// negligible; only a candidate pays for a central directory read.
async function looksLikeArchive(handle: FileHandle, window: VirtualWindow): Promise<boolean> {
  const prefix = await readAt(handle, window, 0, 4);
  const signature = prefix.readUInt32LE(0);
  return signature === LOCAL_SIGNATURE || signature === EOCD_SIGNATURE;
}

async function walk(
  handle: FileHandle,
  root: VirtualWindow,
  entryId: string,
  quota: MaterializeQuota,
): Promise<Walk | null> {
  const segments = entryId.split('.');
  let window = root;
  let path = '';
  for (let index = 0; index < segments.length; index += 1) {
    const records = await readCentralDirectory(handle, window, quota);
    if (!records) return null;
    // Confirm ZIP ownership before applying the depth limit, but reject before
    // returning a compressed ancestor for expansion.
    if (segments.length > quota.maxNesting)
      reject('Archive nesting is deeper than the quota allows');
    const record = records.find((candidate) => candidate.index === Number(segments[index]));
    if (!record) return null;
    checkEntryLimits(record, quota);
    if (index === segments.length - 1) {
      return { kind: 'found', window, record, path: `${path}${record.name}` };
    }
    if (record.method !== METHOD_STORE || isEncrypted(record)) {
      return {
        kind: 'blocked',
        entryId: segments.slice(0, index + 1).join('.'),
        remainder: segments.slice(index + 1).join('.'),
        path: `${path}${record.name}`,
      };
    }
    const start = await dataOffset(handle, window, record);
    window = { offset: window.offset + start, length: record.compressedSize };
    path = `${path}${record.name}/`;
  }
  return null;
}

function applyZip64Extra(record: CentralRecord, extra: Buffer): void {
  const wanted = (['uncompressedSize', 'compressedSize', 'localHeaderOffset'] as const).filter(
    (field) => record[field] === UINT32_SENTINEL,
  );
  if (wanted.length === 0) return;
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const length = extra.readUInt16LE(cursor + 2);
    const body = extra.subarray(cursor + 4, cursor + 4 + length);
    if (body.length !== length) reject('Archive extra field is torn');
    if (id !== ZIP64_EXTRA_ID) {
      cursor += 4 + length;
      continue;
    }
    let at = 0;
    for (const field of wanted) {
      if (at + 8 > body.length) reject('Archive ZIP64 extra field is incomplete');
      record[field] = safeNumber(body.readBigUInt64LE(at), 'ZIP64 field');
      at += 8;
    }
    return;
  }
  reject('Archive entry needs a ZIP64 extra field it does not carry');
}

function isUnsafeName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.startsWith('\\')) return true;
  if (/^[a-zA-Z]:/.test(name)) return true;
  return name.split(/[/\\]/).includes('..');
}

async function dataOffset(
  handle: FileHandle,
  window: VirtualWindow,
  record: CentralRecord,
): Promise<number> {
  const header = await readAt(handle, window, record.localHeaderOffset, LOCAL_FIXED_SIZE);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) reject('Archive local header is malformed');
  if (
    header.readUInt16LE(8) !== record.method ||
    (header.readUInt16LE(6) & FLAG_ENCRYPTED) !== (record.flags & FLAG_ENCRYPTED)
  ) {
    reject('Archive local compression or encryption disagrees with the central directory');
  }
  const offset =
    record.localHeaderOffset + LOCAL_FIXED_SIZE + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (offset + record.compressedSize > record.dataEnd) {
    reject('Archive entry bytes overlap another member or the central directory');
  }
  return offset;
}

async function inflateEntry(
  filePath: string,
  start: number,
  record: CentralRecord,
  destination: string,
  quota: MaterializeQuota,
): Promise<{ sha256: string; size: number }> {
  if (record.compressedSize === 0) reject('Archive entry has no compressed bytes to expand');
  const limit = Math.min(record.uncompressedSize, quota.maxExpandedBytes);
  const digest = createHash('sha256');
  const target = await open(destination, 'wx');
  let written = 0;
  let crc = 0xffffffff;
  const sink = new Writable({
    highWaterMark: 1024 * 1024,
    write(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      written += buffer.length;
      if (written > limit) {
        callback(
          new DomainError('archive-rejected', 422, 'Archive entry expands past its declared size'),
        );
        return;
      }
      digest.update(buffer);
      crc = crc32(buffer, crc);
      target.write(buffer).then(() => callback(), callback);
    },
  });
  const inflate = createInflateRaw();
  const expiry = setTimeout(() => {
    inflate.destroy(
      new DomainError('archive-rejected', 422, 'Archive entry took too long to expand'),
    );
  }, quota.timeoutMs);
  try {
    const source = createReadStream(filePath, {
      start,
      end: start + record.compressedSize - 1,
      highWaterMark: 1024 * 1024,
    });
    try {
      await pipeline(source, inflate, sink);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'Z_DATA_ERROR' || error.code === 'Z_BUF_ERROR')
      ) {
        reject('Archive entry contains invalid DEFLATE data');
      }
      throw error;
    }
    if (inflate.bytesWritten !== record.compressedSize) {
      reject('Archive entry contains trailing bytes after its DEFLATE stream');
    }
    if (written !== record.uncompressedSize) {
      reject('Archive entry did not expand to its declared size');
    }
    if ((crc ^ 0xffffffff) >>> 0 !== record.crc) reject('Archive entry failed its CRC check');
    await target.sync();
  } finally {
    clearTimeout(expiry);
    await target.close();
  }
  return { sha256: digest.digest('hex'), size: written };
}
