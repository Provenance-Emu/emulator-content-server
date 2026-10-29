import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { access, lstat, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { cdiIdentificationPlugin } from './cdi-identification.js';
import { dolphinIdentificationPlugins } from './dolphin-identification.js';
import { type RomFacts, type RomHash, validateRomFacts } from './rom-facts.js';

export interface IdentificationRequest {
  path: string;
  name: string;
  systemId: string | null;
  size: number;
  tools?: { sevenZip?: string; chdman?: string };
}
export interface ToolLimits {
  maxStdoutBytes: number;
  timeoutMs?: number;
  onStdout?: (chunk: Uint8Array) => void;
  outputFile?: { path: string; maxBytes: number };
  cwd?: string;
}
export interface ToolResult {
  stdout: Uint8Array;
  stdoutBytes: number;
  stderr: string;
}
/** Bounded primitives for trusted modules in the isolated worker; not an OS sandbox. */
export interface ReaderContext {
  read(offset: number, length: number): Promise<Uint8Array>;
  stream(offset: number, length: number): AsyncIterable<Uint8Array>;
  runTool(
    tool: 'sevenZip' | 'chdman',
    args: readonly string[],
    limits: ToolLimits,
  ): Promise<ToolResult>;
}
export interface IdentificationPlugin {
  id: string;
  supports(request: IdentificationRequest): boolean;
  identify(
    request: IdentificationRequest,
    reader: ReaderContext,
    signal?: AbortSignal,
  ): Promise<RomFacts>;
}
const MiB = 1024 * 1024,
  MAX_ROM = 64 * MiB,
  MAX_READ = 65 * MiB,
  MAX_PREFIX = 128 * 1024;
const RAW_ID = 'org.ecs.identify.raw',
  SEVEN_ID = 'org.ecs.identify.7z',
  CHD_ID = 'org.ecs.identify.chd';
const CONTAINERS = /\.(zip|7z|rar|chd|cdi|iso|cue|gdi|m3u|ccd|rvz|wia|gcz|ciso|cso|wbfs)$/i;
const ROM_EXT =
  /\.(nes|sfc|smc|j64|jag|rom|bin|n64|v64|z64|gba|gb|gbc|gg|sms|md|gen|smd|a26|a52|a78|lnx|pce|sg|sgx|ws|wsc|vec|col|ngp|ngc|nds|3ds|elf|exe)$/i;
function facts(id?: string): RomFacts {
  return {
    version: 1,
    pluginIds: id ? [id] : [],
    hashes: [],
    identifiers: [],
    names: [],
    warnings: [],
  };
}
function failure(code: string): Error {
  return new Error(code);
}
function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 480 &&
    !isAbsolute(name) &&
    !name.startsWith('\\') &&
    !/^[A-Za-z]:/.test(name) &&
    !name.split(/[/\\]/).some((part) => part === '..' || part.startsWith('@')) &&
    Array.from(name).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  );
}
function checkRange(offset: number, length: number, size: number, max: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    length > max ||
    offset + length > size ||
    !Number.isSafeInteger(offset + length)
  )
    throw failure('reader-range-limit');
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

async function nativeTool(
  request: IdentificationRequest,
  tool: 'sevenZip' | 'chdman',
  args: readonly string[],
  limits: ToolLimits,
  signal: AbortSignal,
  charge: (bytes: number) => void,
): Promise<ToolResult> {
  signal.throwIfAborted();
  const executable = request.tools?.[tool];
  if (!executable || !isAbsolute(executable) || executable.includes('\0'))
    throw failure('tool-not-configured');
  if (
    args.length > 64 ||
    args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) ||
    !Number.isSafeInteger(limits.maxStdoutBytes) ||
    limits.maxStdoutBytes < 0 ||
    limits.maxStdoutBytes > MAX_ROM
  )
    throw failure('tool-limit-invalid');
  if (
    limits.outputFile &&
    (!isAbsolute(limits.outputFile.path) ||
      tool !== 'chdman' ||
      !Number.isSafeInteger(limits.outputFile.maxBytes) ||
      limits.outputFile.maxBytes < 1 ||
      limits.outputFile.maxBytes > 256 * 1024)
  )
    throw failure('tool-file-limit-invalid');
  const executableInfo = await stat(executable);
  await access(executable, constants.X_OK);
  if (!executableInfo.isFile()) throw failure('tool-unavailable');
  signal.throwIfAborted();
  return new Promise<ToolResult>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: limits.cwd ?? tmpdir(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
    });
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    let outSize = 0,
      errorSize = 0,
      fault: unknown,
      closed = false,
      checking = false;
    let killTimer: NodeJS.Timeout | undefined;
    function stop(error: unknown): void {
      fault ??= error;
      if (closed) return;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 100);
      killTimer.unref();
    }
    function abort(): void {
      stop(signal.reason ?? failure('identification-cancelled'));
    }
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => stop(failure('tool-timeout')),
      Math.max(1, Math.min(10000, limits.timeoutMs ?? 10000)),
    );
    timer.unref();
    const poll = limits.outputFile
      ? setInterval(() => {
          if (checking || closed) return;
          checking = true;
          void lstat(limits.outputFile?.path ?? '')
            .then((info) => {
              if (
                !info.isFile() ||
                info.isSymbolicLink() ||
                info.size > (limits.outputFile?.maxBytes ?? 0)
              )
                stop(failure('tool-file-limit'));
            })
            .catch((error) => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                stop(failure('tool-output-unavailable'));
            })
            .finally(() => {
              checking = false;
            });
        }, 10)
      : undefined;
    poll?.unref();
    child.once('error', () => stop(failure('tool-unavailable')));
    child.stdout.on('error', () => stop(failure('tool-output-failed')));
    child.stderr.on('error', () => stop(failure('tool-output-failed')));
    child.stdout.on('data', (value: Buffer) => {
      if (fault) return;
      try {
        outSize += value.length;
        charge(value.length);
        if (outSize > limits.maxStdoutBytes) throw failure('tool-stdout-limit');
        if (limits.onStdout) limits.onStdout(value);
        else output.push(value);
      } catch (error) {
        stop(error);
      }
    });
    child.stderr.on('data', (value: Buffer) => {
      if (fault) return;
      errorSize += value.length;
      if (errorSize > 65536) stop(failure('tool-stderr-limit'));
      else errors.push(value);
    });
    child.once('close', (code) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (poll) clearInterval(poll);
      signal.removeEventListener('abort', abort);
      if (fault) reject(fault);
      else if (signal.aborted) reject(signal.reason);
      else if (code !== 0) reject(failure('tool-failed'));
      else
        resolve({
          stdout: Buffer.concat(output),
          stdoutBytes: outSize,
          stderr: Buffer.concat(errors).toString('utf8'),
        });
    });
    if (signal.aborted) abort();
  });
}

interface Normalization {
  offset: number;
  length?: number;
  representation: string;
  checksum?: number;
}
function normalization(
  prefix: Buffer,
  size: number,
  name: string,
  system: string | null,
): Normalization | null {
  if (
    prefix.length >= 16 &&
    prefix.subarray(0, 4).equals(Buffer.from([78, 69, 83, 26])) &&
    ((prefix[7] ?? 0) & 12) === 0 &&
    prefix.subarray(12, 16).every((byte) => byte === 0)
  ) {
    const offset = 16 + ((prefix[6] ?? 0) & 4 ? 512 : 0),
      length = (prefix[4] ?? 0) * 16384 + (prefix[5] ?? 0) * 8192;
    if ((prefix[4] ?? 0) > 0 && offset + length <= size && size - offset - length <= MiB)
      return { offset, length, representation: 'nes-prg-chr' };
  }
  const payload = size - 512;
  if (
    (system === 'com.provenance.snes' || /\.smc$/i.test(name)) &&
    payload >= 32768 &&
    payload <= MAX_ROM &&
    (payload & (payload - 1)) === 0
  ) {
    for (const offset of [0x7fc0, 0xffc0]) {
      const h = 512 + offset;
      if (h + 64 > prefix.length) continue;
      const title = prefix.subarray(h, h + 21);
      const mode = prefix[h + 21] ?? 0,
        exponent = prefix[h + 23] ?? 0,
        complement = prefix.readUInt16LE(h + 28),
        checksum = prefix.readUInt16LE(h + 30),
        reset = prefix.readUInt16LE(h + 60);
      if (
        title.some((byte) => byte < 32 || byte > 126) ||
        !title.toString('ascii').trim() ||
        ![0x20, 0x21, 0x30, 0x31].includes(mode) ||
        exponent > 16 ||
        2 ** (exponent + 10) !== payload ||
        reset < 0x8000 ||
        (checksum ^ complement) !== 65535 ||
        !checksum ||
        checksum === 65535
      )
        continue;
      return { offset: 512, representation: 'snes-no-copier-header', checksum };
    }
  }
  return null;
}
class Digests {
  private readonly md5 = createHash('md5');
  private readonly sha1 = createHash('sha1');
  private crc = 0;
  size = 0;
  sum = 0;
  update(bytes: Uint8Array, checksum = false): void {
    this.md5.update(bytes);
    this.sha1.update(bytes);
    this.crc = crc32(bytes, this.crc);
    this.size += bytes.length;
    if (checksum) for (const byte of bytes) this.sum = (this.sum + byte) & 65535;
  }
  finish(representation: string): RomHash[] {
    return [
      {
        algorithm: 'md5',
        value: this.md5.digest('hex'),
        size: this.size,
        representation,
        verified: true,
      },
      {
        algorithm: 'sha1',
        value: this.sha1.digest('hex'),
        size: this.size,
        representation,
        verified: true,
      },
      {
        algorithm: 'crc32',
        value: this.crc.toString(16).padStart(8, '0'),
        size: this.size,
        representation,
        verified: true,
      },
    ];
  }
}
class RomAccumulator {
  private readonly raw = new Digests();
  private readonly prefixParts: Buffer[] = [];
  private prefixSize = 0;
  private normalized: Digests | null = null;
  private shape: Normalization | null = null;
  private initialized = false;
  private offset = 0;
  private paddingByte: number | null = null;
  private paddingValid = true;
  constructor(
    private readonly size: number,
    private readonly name: string,
    private readonly system: string | null,
    private readonly representation: string,
  ) {}
  private normalizedBytes(bytes: Uint8Array, position: number): void {
    if (!this.shape || !this.normalized) return;
    const begin = Math.max(0, this.shape.offset - position),
      end =
        this.shape.length === undefined
          ? bytes.length
          : Math.min(bytes.length, this.shape.offset + this.shape.length - position);
    if (end > begin)
      this.normalized.update(bytes.subarray(begin, end), this.shape.checksum !== undefined);
    if (this.shape.length !== undefined) {
      const tail = Math.max(0, this.shape.offset + this.shape.length - position);
      if (tail < bytes.length)
        for (const byte of bytes.subarray(tail)) {
          if (this.paddingByte === null) this.paddingByte = byte;
          if ((byte !== 0 && byte !== 255) || byte !== this.paddingByte) this.paddingValid = false;
        }
    }
  }
  private start(): void {
    if (this.initialized) return;
    this.initialized = true;
    const prefix = Buffer.concat(this.prefixParts);
    this.shape = normalization(prefix, this.size, this.name, this.system);
    if (this.shape) {
      this.normalized = new Digests();
      this.normalizedBytes(prefix, 0);
    }
    this.prefixParts.length = 0;
  }
  update(bytes: Uint8Array): void {
    this.raw.update(bytes);
    if (this.raw.size > this.size || this.raw.size > MAX_ROM) throw failure('expanded-size-limit');
    if (!this.initialized) {
      const take = Math.min(bytes.length, MAX_PREFIX - this.prefixSize);
      if (take) {
        this.prefixParts.push(Buffer.from(bytes.subarray(0, take)));
        this.prefixSize += take;
      }
      if (this.prefixSize === MAX_PREFIX) {
        this.start();
        if (take < bytes.length) this.normalizedBytes(bytes.subarray(take), this.offset + take);
      }
    } else if (this.shape) this.normalizedBytes(bytes, this.offset);
    this.offset += bytes.length;
  }
  finish(): RomHash[] {
    if (this.raw.size !== this.size) throw failure('expanded-size-mismatch');
    this.start();
    const hashes = this.raw.finish(this.representation);
    if (
      this.normalized &&
      this.shape &&
      this.paddingValid &&
      (this.shape.length === undefined || this.normalized.size === this.shape.length) &&
      (this.shape.checksum === undefined || this.normalized.sum === this.shape.checksum)
    )
      hashes.push(...this.normalized.finish(this.shape.representation));
    return hashes;
  }
}
async function raw(
  request: IdentificationRequest,
  reader: ReaderContext,
  signal?: AbortSignal,
): Promise<RomFacts> {
  const result = facts(RAW_ID),
    prefix = Buffer.from(await reader.read(0, Math.min(0x440, request.size)));
  const containers = [
    Buffer.from([0x50, 0x4b, 3, 4]),
    Buffer.from([0x50, 0x4b, 5, 6]),
    Buffer.from([0x50, 0x4b, 7, 8]),
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
    Buffer.from('Rar!'),
    Buffer.from('MComprHD'),
    Buffer.from('CISO'),
    Buffer.from([0x52, 0x56, 0x5a, 1]),
    Buffer.from([0x57, 0x49, 0x41, 1]),
    Buffer.from([1, 0xc0, 0x0b, 0xb1]),
  ];
  if (containers.some((signature) => prefix.subarray(0, signature.length).equals(signature))) {
    result.warnings.push('raw-container-signature-unsupported');
    return result;
  }

  if (
    prefix.length >= 32 &&
    prefix.readUInt32BE(0x1c) === 0xc2339f3d &&
    /^[A-Z0-9]{6}$/.test(prefix.toString('ascii', 0, 6))
  )
    result.identifiers.push({
      type: 'serial',
      value: prefix.toString('ascii', 0, 6),
      systemId: 'com.provenance.gamecube',
      verified: true,
    });
  if (request.size > MAX_ROM) {
    result.warnings.push('raw-hash-size-limit');
    return result;
  }
  const hash = new RomAccumulator(request.size, request.name, request.systemId, 'raw');
  for await (const bytes of reader.stream(0, request.size)) {
    signal?.throwIfAborted();
    hash.update(bytes);
  }
  result.hashes = hash.finish();
  return result;
}
interface SevenEntry {
  path: string;
  size: number;
  packed: number;
  crc: string;
  directory: boolean;
  method: string;
}
function sevenListing(bytes: Uint8Array): SevenEntry[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    parts = text.split(/\r?\n----------\r?\n/);
  if (parts.length !== 2) throw failure('7z-listing-invalid');
  if (!/^Type = 7z\r?$/m.test(parts[0] ?? '') || !/^Solid = -\r?$/m.test(parts[0] ?? ''))
    throw failure('7z-solid-or-format-unsupported');
  const records = (parts[1] ?? '').trim().split(/\r?\n\r?\n/);
  if (records.length > 256) throw failure('7z-entry-limit');
  const entries: SevenEntry[] = [];
  let expanded = 0;
  for (const record of records) {
    const fields = new Map<string, string>();
    for (const line of record.split(/\r?\n/)) {
      const separator = line.indexOf(' = ');
      if (separator < 0) throw failure('7z-listing-invalid');
      const key = line.slice(0, separator);
      if (fields.has(key)) throw failure('7z-listing-invalid');
      fields.set(key, line.slice(separator + 3));
    }
    const path = fields.get('Path') ?? '',
      attributes = fields.get('Attributes') ?? '',
      directory = attributes.startsWith('D') || fields.get('Folder') === '+';
    if (
      !safeName(path) ||
      fields.get('Encrypted') === '+' ||
      fields.has('Symbolic Link') ||
      fields.has('Hard Link') ||
      (/\b([a-z-])[rwxstST-]{9}\b/i.exec(attributes)?.[1] !== undefined &&
        !['-', 'd'].includes(/\b([a-z-])[rwxstST-]{9}\b/i.exec(attributes)?.[1] ?? ''))
    )
      throw failure('7z-unsafe-entry');
    const size = Number(fields.get('Size')),
      packed = Number(fields.get('Packed Size') ?? 0),
      crc = fields.get('CRC') ?? '',
      method = fields.get('Method') ?? '';
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(packed) || packed < 0)
      throw failure('7z-listing-invalid');
    expanded += size;
    if (expanded > MAX_ROM) throw failure('7z-expansion-limit');
    if (
      !directory &&
      ((size > 0 && packed === 0) ||
        (size >= 65536 && size / packed > 100) ||
        !/^([0-9a-f]{8})$/i.test(crc))
    )
      throw failure('7z-ratio-or-crc-limit');
    if (!directory) {
      const codec = /^(?:LZMA2?|Copy)(?::(\d+)([km])?)?(?: BCJ)?$/i.exec(method);
      if (!codec) throw failure('7z-codec-unsupported');
      if (codec[1]) {
        const n = Number(codec[1]),
          unit = codec[2]?.toLowerCase(),
          dictionary = unit === 'k' ? n * 1024 : unit === 'm' ? n * MiB : 2 ** n;
        if (dictionary > MAX_ROM) throw failure('7z-dictionary-limit');
      }
    }
    entries.push({ path, size, packed, crc: crc.toLowerCase(), directory, method });
  }
  return entries;
}
async function sevenZip(
  request: IdentificationRequest,
  reader: ReaderContext,
  signal?: AbortSignal,
): Promise<RomFacts> {
  const result = facts(SEVEN_ID);
  if (request.size > MAX_ROM) {
    result.warnings.push('7z-outer-size-limit');
    return result;
  }
  const magic = Buffer.from(await reader.read(0, Math.min(6, request.size)));
  if (!magic.equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) {
    result.warnings.push('7z-invalid-signature');
    return result;
  }
  const listing = await reader.runTool(
    'sevenZip',
    ['l', '-slt', '-sccUTF-8', '-bd', '--', request.path],
    { maxStdoutBytes: MiB },
  );
  const entries = sevenListing(listing.stdout),
    files = entries.filter((entry) => !entry.directory);
  if (files.some((entry) => CONTAINERS.test(entry.path))) {
    result.warnings.push('7z-nested-or-disc-layout-unsupported');
    return result;
  }
  const roms = files.filter((entry) => ROM_EXT.test(entry.path));
  if (roms.length !== 1) {
    result.warnings.push('7z-no-single-rom');
    return result;
  }
  const member = roms[0];
  if (!member) return result;
  const digest = new RomAccumulator(
    member.size,
    member.path,
    request.systemId,
    `7z-member:${member.path}`,
  );
  await reader.runTool(
    'sevenZip',
    [
      'x',
      '-so',
      '-bd',
      '-bb0',
      '-mmt=1',
      '-sccUTF-8',
      '-spd',
      '-ssc',
      '-y',
      '--',
      request.path,
      member.path,
    ],
    {
      maxStdoutBytes: member.size,
      onStdout: (bytes) => {
        signal?.throwIfAborted();
        digest.update(bytes);
      },
    },
  );
  const hashes = digest.finish();
  if (
    hashes.find(
      (hash) => hash.algorithm === 'crc32' && hash.representation.startsWith('7z-member:'),
    )?.value !== member.crc
  )
    throw failure('7z-crc-mismatch');
  result.hashes = hashes;
  result.names.push(member.path);
  return result;
}

// Header offsets follow official MAME src/lib/util/chd.h (v5), not file-extension guesses.
interface ChdHeader {
  logical: number;
  unit: number;
  hunk: number;
  metadata: number;
  parent: boolean;
}
function chdHeader(header: Buffer, size: number): ChdHeader | null {
  if (
    header.length < 124 ||
    header.toString('ascii', 0, 8) !== 'MComprHD' ||
    header.readUInt32BE(8) !== 124 ||
    header.readUInt32BE(12) !== 5
  )
    return null;
  const logical = Number(header.readBigUInt64BE(32)),
    map = Number(header.readBigUInt64BE(40)),
    metadata = Number(header.readBigUInt64BE(48)),
    hunk = header.readUInt32BE(56),
    unit = header.readUInt32BE(60);
  if (
    !Number.isSafeInteger(logical) ||
    logical <= 0 ||
    logical > 16 * 1024 ** 4 ||
    !Number.isSafeInteger(map) ||
    map < 124 ||
    map >= size ||
    !Number.isSafeInteger(metadata) ||
    metadata < 0 ||
    metadata >= size ||
    !hunk ||
    hunk > 524288 ||
    !unit ||
    hunk % unit ||
    logical % unit
  )
    throw failure('chd-header-invalid');
  return {
    logical,
    unit,
    hunk,
    metadata,
    parent: header.subarray(104, 124).some((byte) => byte !== 0),
  };
}
async function chdMetadata(
  reader: ReaderContext,
  header: ChdHeader,
  size: number,
): Promise<{ tag: string; text: string }[]> {
  const records: { tag: string; text: string }[] = [],
    seen = new Set<number>();
  let offset = header.metadata,
    total = 0;
  while (offset) {
    if (seen.has(offset) || seen.size >= 128 || offset < 124) throw failure('chd-metadata-limit');
    seen.add(offset);
    const record = Buffer.from(await reader.read(offset, 16));
    const length = record.readUIntBE(5, 3);
    total += length + 16;
    if (total > 65536 || offset + 16 + length > size) throw failure('chd-metadata-limit');
    const value = Buffer.from(await reader.read(offset + 16, length));
    const text = value.toString('latin1').replace(/\0$/, '');
    if (Array.from(text).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126))
      throw failure('chd-metadata-invalid');
    records.push({ tag: record.toString('ascii', 0, 4), text });
    const next = Number(record.readBigUInt64BE(8));
    if (!Number.isSafeInteger(next)) throw failure('chd-metadata-limit');
    offset = next;
  }
  return records;
}
async function chdSlice(
  request: IdentificationRequest,
  reader: ReaderContext,
  offset: number,
  length: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 256 * 1024
  )
    throw failure('chd-slice-limit');
  const directory = await mkdtemp(join(tmpdir(), 'ecs-rom-slice-'));
  const path = join(directory, 'slice.bin');
  try {
    await reader.runTool(
      'chdman',
      ['extractraw', '-i', request.path, '-o', path, '-isb', String(offset), '-ib', String(length)],
      { maxStdoutBytes: 65536, outputFile: { path, maxBytes: length }, cwd: directory },
    );
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== length)
      throw failure('chd-slice-size-mismatch');
    return await readFile(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function discPayload(bytes: Buffer, unit: number, mode?: string): Buffer {
  if (unit === 2048 || (unit === 2448 && mode === 'MODE1')) return bytes.subarray(0, 2048);
  if (unit === 2448 || unit === 2352) {
    if (
      bytes.length < 2352 ||
      bytes[0] !== 0 ||
      !bytes.subarray(1, 11).every((byte) => byte === 255) ||
      bytes[11] !== 0
    )
      return Buffer.alloc(0);
    const mode = bytes[15];
    if (mode === 1) return bytes.subarray(16, 2064);
    if (
      mode === 2 &&
      bytes.subarray(16, 20).equals(bytes.subarray(20, 24)) &&
      ((bytes[18] ?? 0) & 0x20) === 0
    )
      return bytes.subarray(24, 2072);
  }
  return Buffer.alloc(0);
}
function asciiField(bytes: Buffer): string {
  const nul = bytes.indexOf(0),
    value = nul < 0 ? bytes : bytes.subarray(0, nul);
  if (nul >= 0 && bytes.subarray(nul).some((byte) => byte !== 0 && byte !== 32)) return '';
  if (value.some((byte) => byte < 32 || byte > 126)) return '';
  return value.toString('ascii').trim();
}
function dreamcast(bytes: Buffer, result: RomFacts): boolean {
  if (!bytes.subarray(0, 16).equals(Buffer.from('SEGA SEGAKATANA '))) return false;
  const serial = asciiField(bytes.subarray(0x40, 0x4a)).toUpperCase();
  if (!/^[A-Z0-9]{1,6}-[A-Z0-9]{3,10}$/.test(serial)) return false;
  result.identifiers.push({
    type: 'serial',
    value: serial,
    systemId: /^(?:GD|GDL|GDS|CDV)-/.test(serial) ? null : 'com.provenance.dreamcast',
    verified: true,
  });
  const title = asciiField(bytes.subarray(0x80, 0x100));
  if (title && Array.from(title).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127))
    result.names.push(title);
  return true;
}
async function isoSerial(
  request: IdentificationRequest,
  reader: ReaderContext,
  header: ChdHeader,
  base: number,
  result: RomFacts,
  mode?: string,
): Promise<void> {
  if (base + 17 * header.unit > header.logical) return;
  const pvd = discPayload(
    await chdSlice(request, reader, base + 16 * header.unit, header.unit),
    header.unit,
    mode,
  );
  if (
    pvd.length !== 2048 ||
    pvd[0] !== 1 ||
    pvd.toString('ascii', 1, 6) !== 'CD001' ||
    pvd[6] !== 1 ||
    pvd.readUInt16LE(128) !== 2048 ||
    pvd.readUInt16BE(130) !== 2048
  )
    return;
  const root = pvd.subarray(156),
    lba = root.readUInt32LE(2),
    rootSize = root.readUInt32LE(10);
  if (
    lba !== root.readUInt32BE(6) ||
    rootSize !== root.readUInt32BE(14) ||
    rootSize < 34 ||
    rootSize > 65536 ||
    base + (lba + Math.ceil(rootSize / 2048)) * header.unit > header.logical
  )
    throw failure('iso-root-limit');
  const sectors: Buffer[] = [];
  for (let index = 0; index < Math.ceil(rootSize / 2048); index++)
    sectors.push(
      discPayload(
        await chdSlice(request, reader, base + (lba + index) * header.unit, header.unit),
        header.unit,
        mode,
      ),
    );
  const directory = Buffer.concat(sectors).subarray(0, rootSize);
  let found: { lba: number; size: number } | undefined;
  for (let offset = 0; offset < directory.length; ) {
    const length = directory[offset] ?? 0;
    if (!length) {
      offset = (Math.floor(offset / 2048) + 1) * 2048;
      continue;
    }
    if (length < 34 || offset + length > directory.length || (offset % 2048) + length > 2048)
      throw failure('iso-directory-invalid');
    const record = directory.subarray(offset, offset + length),
      nameLength = record[32] ?? 0;
    if (33 + nameLength > length) throw failure('iso-directory-invalid');
    const name = record.toString('ascii', 33, 33 + nameLength).toUpperCase();
    if (name === 'SYSTEM.CNF;1' || name === 'SYSTEM.CNF') {
      if (found) throw failure('iso-serial-ambiguous');
      const lba = record.readUInt32LE(2),
        size = record.readUInt32LE(10);
      if (
        lba !== record.readUInt32BE(6) ||
        size !== record.readUInt32BE(14) ||
        size < 1 ||
        size > 8192 ||
        (record[25] ?? 0) & 0x82 ||
        base + (lba + Math.ceil(size / 2048)) * header.unit > header.logical
      )
        throw failure('iso-configuration-limit');
      found = { lba, size };
    }
    offset += length;
  }
  if (!found) return;
  const parts: Buffer[] = [];
  for (let n = 0; n < Math.ceil(found.size / 2048); n++)
    parts.push(
      discPayload(
        await chdSlice(request, reader, base + (found.lba + n) * header.unit, header.unit),
        header.unit,
        mode,
      ),
    );
  const config = Buffer.concat(parts).subarray(0, found.size).toString('ascii');
  const boots = [
    ...config.matchAll(/^\s*BOOT\s*=\s*cdrom:\\([A-Z]{4})[_-](\d{3})[.](\d{2})(?:;1)?\s*$/gim),
  ];
  if (boots.length === 1) {
    const match = boots[0];
    if (match)
      result.identifiers.push({
        type: 'serial',
        value: `${match[1]}-${match[2]}${match[3]}`,
        systemId: 'com.provenance.psx',
        verified: true,
      });
  }
}
async function chd(request: IdentificationRequest, reader: ReaderContext): Promise<RomFacts> {
  const result = facts(CHD_ID),
    bytes = Buffer.from(await reader.read(0, Math.min(124, request.size))),
    header = chdHeader(bytes, request.size);
  if (!header) {
    result.warnings.push('chd-version-or-header-unsupported');
    return result;
  }
  for (const [offset, representation] of [
    [64, 'chd-raw-sha1'],
    [84, 'chd-combined-sha1'],
  ] as const) {
    const value = bytes.subarray(offset, offset + 20);
    if (value.some((byte) => byte !== 0))
      result.hashes.push({
        algorithm: 'sha1',
        value: value.toString('hex'),
        size: header.logical,
        representation,
        verified: false,
      });
  }
  result.warnings.push('chd-header-hashes-declared-not-verified');
  if (header.parent) {
    result.warnings.push('chd-parent-required');
    return result;
  }
  if (!request.tools?.chdman) {
    result.warnings.push('chd-decoder-not-configured');
    return result;
  }
  try {
    const metadata = await chdMetadata(reader, header, request.size);
    if (metadata.some((record) => ['CHCD', 'CHGT', 'GDDD', 'AVAV', 'AVLD'].includes(record.tag))) {
      result.warnings.push('chd-layout-or-patched-metadata-unsupported');
      return result;
    }
    const tracks = metadata.filter((record) => record.tag === 'CHT2' || record.tag === 'CHGD');
    if (
      tracks.length > 99 ||
      new Set(tracks.map((track) => track.tag)).size > 1 ||
      metadata.some(
        (record) => record.tag === 'CHTR' || (record.tag === 'CHSE' && record.text !== 'SESSION:1'),
      )
    ) {
      result.warnings.push('chd-track-layout-unsupported');
      return result;
    }
    const bases: { offset: number; mode?: string }[] = tracks.length ? [] : [{ offset: 0 }];
    let frame = 0;
    for (const [index, track] of tracks.entries()) {
      const match =
        /^TRACK:(\d+) TYPE:([A-Z0-9_]+) SUBTYPE:([A-Z0-9_]+) FRAMES:(\d+)(?: PAD:(\d+))? PREGAP:(\d+) PGTYPE:([A-Z0-9_]+) PGSUB:([A-Z0-9_]+) POSTGAP:(\d+)$/.exec(
          track.text,
        );
      if (
        !match ||
        Number(match[1]) !== index + 1 ||
        match[3] !== 'NONE' ||
        match[6] !== '0' ||
        match[8] !== 'NONE' ||
        match[9] !== '0' ||
        !['AUDIO', 'MODE1', 'MODE1_RAW', 'MODE2_RAW'].includes(match[2] ?? '') ||
        (track.tag === 'CHGD') !== (match[5] !== undefined)
      ) {
        result.warnings.push('chd-track-layout-unsupported');
        return result;
      }
      const count = Number(match[4]),
        pad = Number(match[5] ?? 0);
      if (
        !Number.isSafeInteger(count) ||
        count < 1 ||
        !Number.isSafeInteger(pad) ||
        pad < 0 ||
        pad > count
      ) {
        result.warnings.push('chd-track-layout-unsupported');
        return result;
      }
      if (match[2] !== 'AUDIO') bases.push({ offset: frame * header.unit, mode: match[2] });
      frame += Math.ceil(count / 4) * 4;
    }
    if (
      bases.length > 8 ||
      (tracks.length && (header.unit !== 2448 || frame * header.unit !== header.logical))
    ) {
      result.warnings.push('chd-track-layout-unsupported');
      return result;
    }
    if (![2048, 2352, 2448].includes(header.unit)) {
      result.warnings.push('chd-sector-layout-unsupported');
      return result;
    }
    for (const base of bases) {
      if (base.offset + header.unit > header.logical) continue;
      const first = discPayload(
        await chdSlice(request, reader, base.offset, header.unit),
        header.unit,
        base.mode,
      );
      if (dreamcast(first, result)) continue;
      // Multi-track ISO logical-address rebasing needs a format-specific reader;
      // do not guess it from a secondary data track's CHD byte position.
      if (base.offset === 0) await isoSerial(request, reader, header, 0, result, base.mode);
    }
    if (!result.identifiers.length) result.warnings.push('chd-no-bounded-disc-identifier');
  } catch {
    result.warnings.push('chd-decoder-or-layout-unsupported');
  }
  return result;
}
const BUILTINS: readonly IdentificationPlugin[] = [
  { id: RAW_ID, supports: (request) => !CONTAINERS.test(request.name), identify: raw },
  { id: SEVEN_ID, supports: (request) => /\.7z$/i.test(request.name), identify: sevenZip },
  { id: CHD_ID, supports: (request) => /\.chd$/i.test(request.name), identify: chd },
  cdiIdentificationPlugin,
  ...dolphinIdentificationPlugins,
];
function merge(target: RomFacts, addition: RomFacts, id: string): void {
  for (const key of ['pluginIds', 'hashes', 'identifiers', 'names', 'warnings'] as const) {
    const limit = key === 'pluginIds' || key === 'hashes' ? 16 : 32;
    const values = [...target[key], ...addition[key], ...(key === 'pluginIds' ? [id] : [])];
    const unique = [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
    (target as unknown as Record<string, unknown>)[key] = unique.slice(0, limit);
  }
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? failure('identification-cancelled'));
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      },
    );
  });
}
export async function identifyRom(
  request: IdentificationRequest,
  signal?: AbortSignal,
  additionalPlugins: readonly IdentificationPlugin[] = [],
): Promise<RomFacts> {
  signal?.throwIfAborted();
  if (
    typeof request.path !== 'string' ||
    !isAbsolute(request.path) ||
    !Number.isSafeInteger(request.size) ||
    request.size < 0 ||
    typeof request.name !== 'string' ||
    request.name.length < 1 ||
    request.name.length > 512 ||
    additionalPlugins.length > 13
  )
    throw failure('identification-request-invalid');
  const limited = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]),
    handle = await open(request.path, 'r');
  const activeTools = new Set<Promise<ToolResult>>();
  let consumed = 0,
    calls = 0;
  function charge(bytes: number): void {
    consumed += bytes;
    if (consumed > MAX_READ) throw failure('reader-total-limit');
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(request.size)) throw failure('source-changed');
    async function readExact(offset: number, length: number): Promise<Uint8Array> {
      limited.throwIfAborted();
      checkRange(offset, length, request.size, MiB);
      charge(length);
      const bytes = Buffer.alloc(length);
      const result = await handle.read(bytes, 0, length, offset);
      limited.throwIfAborted();
      if (result.bytesRead !== length) throw failure('source-changed');
      return bytes;
    }
    const reader: ReaderContext = {
      read: readExact,
      async *stream(offset, length) {
        checkRange(offset, length, request.size, MAX_ROM);
        let position = offset;
        while (position < offset + length) {
          limited.throwIfAborted();
          const bytes = await readExact(position, Math.min(65536, offset + length - position));
          position += bytes.length;
          yield bytes;
        }
      },
      runTool(tool, args, limits) {
        if (activeTools.size) throw failure('tool-busy');
        if (++calls > 48) throw failure('tool-call-limit');
        const owned = nativeTool(request, tool, args, limits, limited, charge).finally(() => {
          activeTools.delete(owned);
        });
        activeTools.add(owned);
        void owned.catch(() => undefined);
        return owned;
      },
    };
    const result = facts();
    const seen = new Set<string>();
    for (const plugin of [...BUILTINS, ...additionalPlugins]) {
      limited.throwIfAborted();
      if (
        typeof plugin.id !== 'string' ||
        plugin.id.length > 120 ||
        !/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(plugin.id) ||
        seen.has(plugin.id)
      ) {
        result.warnings.push('identification-plugin-id-conflict');
        continue;
      }
      seen.add(plugin.id);
      try {
        if (!plugin.supports(request)) continue;
        const output = validateRomFacts(
          await abortable(plugin.identify(request, reader, limited), limited),
        );
        merge(result, output, plugin.id);
      } catch {
        limited.throwIfAborted();
        result.pluginIds.push(plugin.id);
        result.warnings.push(`${plugin.id}:unsupported-or-unavailable`);
      }
    }
    limited.throwIfAborted();
    const [after, current] = await Promise.all([
      handle.stat({ bigint: true }),
      stat(request.path, { bigint: true }),
    ]);
    if (!same(before, after) || !same(before, current)) throw failure('source-changed');
    if (!result.pluginIds.length) result.warnings.push('no-identification-plugin');
    return validateRomFacts(result);
  } finally {
    await Promise.allSettled([...activeTools]);
    await handle.close();
  }
}
