import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import {
  DomainError,
  type MaterializeQuota,
  type VirtualContentProvider,
  type VirtualEntry,
  type VirtualEntryLocation,
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
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const DECIMAL_INDEX = /^\d{1,10}$/;
const NESTED_ARCHIVE = /\.(7z|bz2|gz|rar|tar|tgz|xz|zip|zst)$/i;

// A high ratio on a small entry is ordinary compression, so the ratio limit only
// applies once an entry is large enough for the expansion to matter.
const RATIO_FLOOR_BYTES = 64 * 1024;

interface CentralRecord {
  index: number;
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface Archive {
  size: number;
  records: CentralRecord[];
}

export class ZipProvider implements VirtualContentProvider {
  readonly format = 'zip';

  async inspect(
    filePath: string,
    quota: MaterializeQuota,
  ): Promise<{ entries: VirtualEntry[] } | null> {
    return withArchive(filePath, quota, async (_handle, archive) => ({
      entries: archive.records.map(toEntry),
    }));
  }

  async locate(
    filePath: string,
    entryId: string,
    quota: MaterializeQuota,
  ): Promise<VirtualEntryLocation | null> {
    if (!DECIMAL_INDEX.test(entryId)) return null;
    return withArchive(filePath, quota, async (handle, archive) => {
      const record = findRecord(archive, entryId);
      if (!record) return null;
      if (record.method !== METHOD_STORE || isEncrypted(record)) {
        return { entry: toEntry(record), sourceOffset: null };
      }
      return { entry: toEntry(record), sourceOffset: await dataOffset(handle, archive, record) };
    });
  }

  async materialize(
    filePath: string,
    entryId: string,
    destination: string,
    quota: MaterializeQuota,
  ): Promise<{ sha256: string; size: number }> {
    const expanded = DECIMAL_INDEX.test(entryId)
      ? await withArchive(filePath, quota, async (handle, archive) => {
          const record = findRecord(archive, entryId);
          if (!record) return null;
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
          const start = await dataOffset(handle, archive, record);
          return inflateEntry(filePath, start, record, destination, quota);
        })
      : null;
    if (!expanded) throw new DomainError('not-found', 404, 'Archive entry not found');
    return expanded;
  }
}

function toEntry(record: CentralRecord): VirtualEntry {
  return {
    entryId: String(record.index),
    path: record.name,
    compressedSize: record.compressedSize,
    uncompressedSize: record.uncompressedSize,
    method: methodName(record.method),
  };
}

function findRecord(archive: Archive, entryId: string): CentralRecord | undefined {
  const index = Number(entryId);
  return archive.records.find((record) => record.index === index);
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
  quota: MaterializeQuota,
  use: (handle: FileHandle, archive: Archive) => Promise<T | null>,
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
    const records = await readCentralDirectory(handle, size, quota);
    if (!records) return null;
    return await use(handle, { size, records });
  } finally {
    await handle.close();
  }
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
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
}

async function readEndRecord(handle: FileHandle, size: number): Promise<EndRecord | null> {
  if (size < EOCD_FIXED_SIZE) return null;
  const tailLength = Math.min(size, MAX_COMMENT_BYTES + EOCD_FIXED_SIZE);
  const tail = await readAt(handle, size - tailLength, tailLength);
  for (let offset = tail.length - EOCD_FIXED_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    if (offset + EOCD_FIXED_SIZE + tail.readUInt16LE(offset + 20) !== tail.length) continue;
    const end = {
      totalEntries: tail.readUInt16LE(offset + 10),
      directorySize: tail.readUInt32LE(offset + 12),
      directoryOffset: tail.readUInt32LE(offset + 16),
    };
    const zip64 =
      end.totalEntries === UINT16_SENTINEL ||
      end.directorySize === UINT32_SENTINEL ||
      end.directoryOffset === UINT32_SENTINEL;
    return zip64 ? readZip64EndRecord(handle, size - tailLength + offset) : end;
  }
  return null;
}

async function readZip64EndRecord(handle: FileHandle, endOffset: number): Promise<EndRecord> {
  const locatorOffset = endOffset - ZIP64_LOCATOR_SIZE;
  if (locatorOffset < 0) reject('Archive claims ZIP64 without a locator');
  const locator = await readAt(handle, locatorOffset, ZIP64_LOCATOR_SIZE);
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) {
    reject('Archive claims ZIP64 without a locator');
  }
  const recordOffset = safeNumber(locator.readBigUInt64LE(8), 'ZIP64 end record offset');
  const record = await readAt(handle, recordOffset, ZIP64_EOCD_FIXED_SIZE);
  if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE)
    reject('Archive ZIP64 end record is missing');
  return {
    totalEntries: safeNumber(record.readBigUInt64LE(32), 'Archive entry count'),
    directorySize: safeNumber(record.readBigUInt64LE(40), 'Central directory size'),
    directoryOffset: safeNumber(record.readBigUInt64LE(48), 'Central directory offset'),
  };
}

async function readCentralDirectory(
  handle: FileHandle,
  size: number,
  quota: MaterializeQuota,
): Promise<CentralRecord[] | null> {
  const end = await readEndRecord(handle, size);
  if (!end) return null;
  if (end.totalEntries > quota.maxEntries) {
    reject('Archive declares more entries than the quota allows');
  }
  if (end.directorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
    reject('Archive central directory is too large to parse');
  }
  if (end.directoryOffset + end.directorySize > size) {
    reject('Archive central directory falls outside the file');
  }
  const directory = await readAt(handle, end.directoryOffset, end.directorySize);
  const records: CentralRecord[] = [];
  let cursor = 0;
  let expanded = 0;
  for (let index = 0; index < end.totalEntries; index += 1) {
    if (cursor + CENTRAL_FIXED_SIZE > directory.length) reject('Archive central directory is torn');
    if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      reject('Archive central directory is malformed');
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
      crc: directory.readUInt32LE(cursor + 16),
      compressedSize: directory.readUInt32LE(cursor + 20),
      uncompressedSize: directory.readUInt32LE(cursor + 24),
      localHeaderOffset: directory.readUInt32LE(cursor + 42),
    };
    applyZip64Extra(record, directory.subarray(extraAt, extraAt + extraLength));
    cursor = next;
    if (isUnsafeName(record.name)) reject('Archive entry name escapes its own tree');
    if (record.name.endsWith('/')) continue;
    if (quota.maxNesting <= 1 && NESTED_ARCHIVE.test(record.name)) {
      reject('Archive contains a nested archive');
    }
    if (record.localHeaderOffset >= size) reject('Archive entry header falls outside the file');
    if (record.compressedSize === 0 && record.uncompressedSize > 0) {
      reject('Archive entry declares expansion from no compressed bytes');
    }
    if (
      record.uncompressedSize >= RATIO_FLOOR_BYTES &&
      record.uncompressedSize / record.compressedSize > quota.maxCompressionRatio
    ) {
      reject('Archive entry exceeds the allowed compression ratio');
    }
    expanded += record.uncompressedSize;
    if (expanded > quota.maxExpandedBytes) {
      reject('Archive expands past the allowed total size');
    }
    records.push(record);
  }
  return records;
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
  archive: Archive,
  record: CentralRecord,
): Promise<number> {
  const header = await readAt(handle, record.localHeaderOffset, LOCAL_FIXED_SIZE);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) reject('Archive local header is malformed');
  const offset =
    record.localHeaderOffset + LOCAL_FIXED_SIZE + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (offset + record.compressedSize > archive.size) {
    reject('Archive entry bytes fall outside the file');
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
    await pipeline(source, inflate, sink);
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
