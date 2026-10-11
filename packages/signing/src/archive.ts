import { type FileHandle, open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

/**
 * Just enough of a zip reader to look inside an IPA: name every entry and pull
 * out the few small ones that say what the app is. `@ecs/storage` has a far more
 * careful reader, built for untrusted archives a library scan might meet, but it
 * belongs to the content server and this package may not import it.
 *
 * An IPA an operator is about to install is not untrusted in the same way, so
 * what matters here is refusing to allocate on a claim: an entry is only
 * expanded when it is asked for by name and its size is within the caller's
 * budget.
 */

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_FIXED_SIZE = 22;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_FIXED_SIZE = 46;
const LOCAL_FIXED_SIZE = 30;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const UINT16_SENTINEL = 0xffff;
const UINT32_SENTINEL = 0xffffffff;
const ZIP64_EXTRA_ID = 0x0001;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const MAX_COMMENT_BYTES = 0xffff;
const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface ArchiveEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  encrypted: boolean;
  localHeaderOffset: number;
}

export class Archive {
  private constructor(
    private readonly handle: FileHandle,
    readonly entries: ArchiveEntry[],
  ) {}

  static async open(path: string): Promise<Archive> {
    const handle = await open(path, 'r');
    try {
      return new Archive(handle, await readDirectory(handle));
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  find(name: string): ArchiveEntry | null {
    return this.entries.find((entry) => entry.name === name) ?? null;
  }

  /** Entries directly inside `prefix`, which is how an app bundle is found. */
  childrenOf(prefix: string): string[] {
    const depth = prefix.split('/').filter(Boolean).length;
    const names = new Set<string>();
    for (const entry of this.entries) {
      if (!entry.name.startsWith(prefix)) continue;
      const parts = entry.name.split('/').filter(Boolean);
      const child = parts[depth];
      if (child !== undefined) names.add(child);
    }
    return [...names].sort();
  }

  async read(name: string, maxBytes: number): Promise<Uint8Array> {
    const entry = this.find(name);
    if (!entry) throw new ArchiveError(`${name} is not in the archive`);
    if (entry.encrypted) throw new ArchiveError(`${name} is encrypted`);
    if (entry.size > maxBytes) {
      throw new ArchiveError(`${name} is ${entry.size} bytes, over the ${maxBytes} byte budget`);
    }
    const local = Buffer.alloc(LOCAL_FIXED_SIZE);
    await this.handle.read(local, 0, local.length, entry.localHeaderOffset);
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    const start = entry.localHeaderOffset + LOCAL_FIXED_SIZE + nameLength + extraLength;
    const raw = Buffer.alloc(entry.compressedSize);
    await this.handle.read(raw, 0, raw.length, start);
    if (entry.method === METHOD_STORE) return new Uint8Array(raw);
    if (entry.method !== METHOD_DEFLATE) {
      throw new ArchiveError(`${name} uses compression method ${entry.method}`);
    }
    const expanded = inflateRawSync(raw, { maxOutputLength: maxBytes });
    return new Uint8Array(expanded);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

async function readDirectory(handle: FileHandle): Promise<ArchiveEntry[]> {
  const { size } = await handle.stat();
  const tailLength = Math.min(size, EOCD_FIXED_SIZE + MAX_COMMENT_BYTES);
  const tail = Buffer.alloc(tailLength);
  await handle.read(tail, 0, tailLength, size - tailLength);
  const eocd = findSignature(tail, EOCD_SIGNATURE, EOCD_FIXED_SIZE);
  if (eocd === -1) throw new ArchiveError('No end of central directory record');
  let count = tail.readUInt16LE(eocd + 10);
  let directoryBytes = tail.readUInt32LE(eocd + 12);
  let directoryAt = tail.readUInt32LE(eocd + 16);
  if (count === UINT16_SENTINEL || directoryAt === UINT32_SENTINEL) {
    const zip64 = await readZip64(handle, tail, eocd, size);
    count = zip64.count;
    directoryBytes = zip64.directoryBytes;
    directoryAt = zip64.directoryAt;
  }
  if (directoryBytes > MAX_DIRECTORY_BYTES) {
    throw new ArchiveError('The central directory is implausibly large');
  }
  const directory = Buffer.alloc(directoryBytes);
  await handle.read(directory, 0, directoryBytes, directoryAt);
  const entries: ArchiveEntry[] = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + CENTRAL_FIXED_SIZE > directory.length) {
      throw new ArchiveError('The central directory ends mid-record');
    }
    if (directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new ArchiveError('A central directory record has the wrong signature');
    }
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const name = directory.toString(
      'utf8',
      at + CENTRAL_FIXED_SIZE,
      at + CENTRAL_FIXED_SIZE + nameLength,
    );
    const extra = directory.subarray(
      at + CENTRAL_FIXED_SIZE + nameLength,
      at + CENTRAL_FIXED_SIZE + nameLength + extraLength,
    );
    const entry: ArchiveEntry = {
      name,
      method: directory.readUInt16LE(at + 10),
      encrypted: (directory.readUInt16LE(at + 8) & FLAG_ENCRYPTED) !== 0,
      compressedSize: directory.readUInt32LE(at + 20),
      size: directory.readUInt32LE(at + 24),
      localHeaderOffset: directory.readUInt32LE(at + 42),
    };
    applyZip64Extra(entry, extra);
    entries.push(entry);
    at += CENTRAL_FIXED_SIZE + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readZip64(
  handle: FileHandle,
  tail: Buffer,
  eocd: number,
  size: number,
): Promise<{ count: number; directoryBytes: number; directoryAt: number }> {
  const locator = tail.lastIndexOf(signatureBytes(ZIP64_LOCATOR_SIGNATURE), eocd);
  if (locator === -1) throw new ArchiveError('A zip64 archive has no locator');
  const recordAt = Number(tail.readBigUInt64LE(locator + 8));
  if (recordAt < 0 || recordAt >= size) throw new ArchiveError('The zip64 record is out of range');
  const record = Buffer.alloc(56);
  await handle.read(record, 0, record.length, recordAt);
  if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
    throw new ArchiveError('The zip64 record has the wrong signature');
  }
  return {
    count: Number(record.readBigUInt64LE(32)),
    directoryBytes: Number(record.readBigUInt64LE(40)),
    directoryAt: Number(record.readBigUInt64LE(48)),
  };
}

/** Zip64 moves a size or an offset into the extra field once it stops fitting. */
function applyZip64Extra(entry: ArchiveEntry, extra: Buffer): void {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (id === ZIP64_EXTRA_ID) {
      let field = at + 4;
      if (entry.size === UINT32_SENTINEL && field + 8 <= extra.length) {
        entry.size = Number(extra.readBigUInt64LE(field));
        field += 8;
      }
      if (entry.compressedSize === UINT32_SENTINEL && field + 8 <= extra.length) {
        entry.compressedSize = Number(extra.readBigUInt64LE(field));
        field += 8;
      }
      if (entry.localHeaderOffset === UINT32_SENTINEL && field + 8 <= extra.length) {
        entry.localHeaderOffset = Number(extra.readBigUInt64LE(field));
      }
      return;
    }
    at += 4 + length;
  }
}

function findSignature(buffer: Buffer, signature: number, fixedSize: number): number {
  for (let at = buffer.length - fixedSize; at >= 0; at -= 1) {
    if (buffer.readUInt32LE(at) === signature) return at;
  }
  return -1;
}

function signatureBytes(signature: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(signature);
  return bytes;
}
