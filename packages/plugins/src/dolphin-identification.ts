import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type { RomFacts, RomIdentifier } from './rom-facts.js';
import type {
  IdentificationPlugin,
  IdentificationRequest,
  ReaderContext,
} from './rom-identification.js';

/** Bounded logical windows. This interface neither mounts nor converts a full image. */
export interface LogicalRomReader {
  size: number;
  representation: string;
  read(offset: number, length: number): Promise<Uint8Array>;
}
const MiB = 1024 * 1024,
  WINDOW = 65536,
  MAX_IMAGE = 16 * 1024 * MiB,
  HEADER1 = 0x48;
const RVZ_ID = 'org.ecs.identify.rvz',
  CISO_ID = 'org.ecs.identify.ciso';
function unsupported(code: string): never {
  throw new Error(code);
}
function facts(id: string): RomFacts {
  return { version: 1, pluginIds: [id], hashes: [], identifiers: [], names: [], warnings: [] };
}
function integer(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) unsupported('disc-offset-limit');
  return Number(value);
}
function range(offset: number, length: number, size: number, cap = WINDOW): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    length > cap ||
    !Number.isSafeInteger(offset + length) ||
    offset + length > size
  )
    unsupported('disc-window-limit');
}
async function physical(
  request: IdentificationRequest,
  reader: ReaderContext,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  range(offset, length, request.size, MiB);
  const bytes = Buffer.from(await reader.read(offset, length));
  signal?.throwIfAborted();
  if (bytes.length !== length) unsupported('disc-truncated');
  return bytes;
}
function discId(header: Buffer): RomIdentifier | null {
  if (header.length < 32 || !/^[A-Z0-9]{6}$/.test(header.toString('ascii', 0, 6))) return null;
  const gc = header.readUInt32BE(0x1c) === 0xc2339f3d,
    wii = header.readUInt32BE(0x18) === 0x5d1c9ea3;
  if (gc === wii) return null;
  return {
    type: 'serial',
    value: header.toString('ascii', 0, 6),
    systemId: gc ? 'com.provenance.gamecube' : 'com.provenance.wii',
    verified: true,
  };
}
function power(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

/** Official Dolphin WIABlob: Read(0..0x7f) copies Header2::disc_header directly.
 * https://github.com/dolphin-emu/dolphin/blob/master/docs/WiaAndRvz.md
 * This validates the header and referenced metadata bounds, not every packet. */
async function rvzHeader(
  request: IdentificationRequest,
  reader: ReaderContext,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; kind: 'rvz' | 'wia'; discType: number } | null> {
  if (request.size < HEADER1) return null;
  const h1 = await physical(request, reader, 0, HEADER1, signal);
  const magic = h1.toString('binary', 0, 4),
    kind = magic === 'RVZ\x01' ? 'rvz' : magic === 'WIA\x01' ? 'wia' : null;
  if (!kind) return null;
  const version = h1.readUInt32BE(4),
    compatible = h1.readUInt32BE(8),
    minimum = kind === 'rvz' ? 0x00030000 : 0x00080000;
  if (compatible > 0x01000000 || version < minimum || compatible > version)
    unsupported('rvz-version-unsupported');
  if (!createHash('sha1').update(h1.subarray(0, 52)).digest().equals(h1.subarray(52, 72)))
    unsupported('rvz-header1-hash');
  const h2size = h1.readUInt32BE(12),
    logical = integer(h1.readBigUInt64BE(36)),
    stored = integer(h1.readBigUInt64BE(44));
  if (
    stored !== request.size ||
    logical < 128 ||
    logical > MAX_IMAGE ||
    h2size < 0xd5 ||
    h2size > WINDOW ||
    HEADER1 + h2size > stored
  )
    unsupported('rvz-header-range');
  const h2 = await physical(request, reader, HEADER1, h2size, signal);
  if (!createHash('sha1').update(h2).digest().equals(h1.subarray(16, 36)))
    unsupported('rvz-header2-hash');
  const discType = h2.readUInt32BE(0),
    compression = h2.readUInt32BE(4),
    chunk = h2.readUInt32BE(12),
    props = h2[212] ?? 255;
  if (
    discType > 2 ||
    compression > (kind === 'rvz' ? 5 : 4) ||
    (kind === 'rvz' && compression === 1) ||
    !chunk ||
    chunk > 64 * MiB ||
    ((kind === 'wia' || chunk < 32768 || !power(chunk)) && chunk % (2 * MiB) !== 0) ||
    props > 7 ||
    0xd5 + props > h2size
  )
    unsupported('rvz-compression-or-chunk-unsupported');
  const expectedProps = compression === 3 ? 5 : compression === 4 ? 1 : 0;
  if (props !== expectedProps) unsupported('rvz-compressor-properties');
  if (compression === 3 && (h2[213] ?? 255) >= 225) unsupported('rvz-compressor-properties');
  if (compression === 4 && (h2[213] ?? 255) > 40) unsupported('rvz-compressor-properties');
  const afterHeader = HEADER1 + h2size,
    regions: { offset: number; length: number }[] = [];
  function table(offset: number, length: number, count: number, cap = 16 * MiB): void {
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > 1048576 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      (count > 0 && length === 0)
    )
      unsupported('rvz-table-limit');
    if (!length) return;
    range(offset, length, stored, cap);
    if (
      offset < afterHeader ||
      regions.some(
        (region) => offset < region.offset + region.length && offset + length > region.offset,
      )
    )
      unsupported('rvz-table-range');
    regions.push({ offset, length });
  }
  const partCount = h2.readUInt32BE(144),
    partSize = h2.readUInt32BE(148),
    partOffset = integer(h2.readBigUInt64BE(152));
  if (partCount > 4096 || partSize > 4096 || (partCount > 0 && partSize === 0))
    unsupported('rvz-partition-limit');
  const partBytes = partCount * partSize;
  table(partOffset, partBytes, partCount, MiB);
  const partition = partBytes
    ? await physical(request, reader, partOffset, partBytes, signal)
    : Buffer.alloc(0);
  if (!createHash('sha1').update(partition).digest().equals(h2.subarray(160, 180)))
    unsupported('rvz-partition-hash');
  table(integer(h2.readBigUInt64BE(184)), h2.readUInt32BE(192), h2.readUInt32BE(180));
  table(integer(h2.readBigUInt64BE(200)), h2.readUInt32BE(208), h2.readUInt32BE(196));
  return { bytes: h2.subarray(16, 144), kind, discType };
}

/** Dolphin CISO uses a 0x8000 header and one byte per sparse block. It has no
 * DEFLATE packets and its logical data size is an upper bound, like Dolphin's reader. */
export async function openDolphinCiso(
  request: IdentificationRequest,
  reader: ReaderContext,
  signal?: AbortSignal,
): Promise<LogicalRomReader | null> {
  if (request.size < 8) return null;
  const prefix = await physical(request, reader, 0, 8, signal);
  if (prefix.toString('ascii', 0, 4) !== 'CISO') return null;
  const block = prefix.readUInt32LE(4);
  if (!power(block) || block < 2048) return null;
  if (block > 32 * MiB || request.size < 0x8000) unsupported('ciso-block-or-header-limit');
  const header = await physical(request, reader, 0, 0x8000, signal),
    map = header.subarray(8),
    positions = new Int32Array(map.length);
  let used = 0;
  for (let index = 0; index < map.length; index++) {
    const flag = map[index];
    if (flag !== 0 && flag !== 1) unsupported('ciso-block-map-invalid');
    positions[index] = flag === 1 ? used++ : -1;
  }
  if (0x8000 + used * block !== request.size) unsupported('ciso-physical-size-mismatch');
  const size = map.length * block;
  return {
    size,
    representation: 'dolphin-ciso-logical',
    async read(offset, length) {
      range(offset, length, size);
      signal?.throwIfAborted();
      const output = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const logical = offset + done,
          index = Math.floor(logical / block),
          within = logical % block,
          take = Math.min(length - done, block - within),
          position = positions[index];
        if (position === undefined) unsupported('ciso-map-range');
        if (position >= 0)
          (await physical(request, reader, 0x8000 + position * block + within, take, signal)).copy(
            output,
            done,
          );
        done += take;
      }
      return output;
    },
  };
}

/** PSP CSOv0/v1 follows PPSSPP BlockDevices.cpp, not Dolphin's sparse CISO.
 * https://github.com/hrydgard/ppsspp/blob/master/Core/FileSystems/BlockDevices.cpp */
export async function openPspCso(
  request: IdentificationRequest,
  reader: ReaderContext,
  signal?: AbortSignal,
): Promise<LogicalRomReader | null> {
  if (request.size < 24) return null;
  const header = await physical(request, reader, 0, 24, signal);
  if (header.toString('ascii', 0, 4) !== 'CISO' || ![0, 24].includes(header.readUInt32LE(4)))
    return null;
  const size = integer(header.readBigUInt64LE(8)),
    block = header.readUInt32LE(16),
    version = header[20] ?? 255,
    align = header[21] ?? 255;
  if (
    version > 1 ||
    header[22] !== 0 ||
    header[23] !== 0 ||
    size < 2048 ||
    size > 4 * 1024 * MiB ||
    size % 2048 ||
    !power(block) ||
    block < 2048 ||
    block > 65536 ||
    align > 16
  )
    unsupported('cso-header-unsupported');
  const frames = Math.ceil(size / block),
    indexEnd = 24 + (frames + 1) * 4;
  if (indexEnd > request.size || frames > 2097152) unsupported('cso-index-range');
  const factor = 2 ** align;
  const first = (await physical(request, reader, 24, 4, signal)).readUInt32LE(0) & 0x7fffffff,
    last =
      (await physical(request, reader, 24 + frames * 4, 4, signal)).readUInt32LE(0) & 0x7fffffff;
  const start = first * factor,
    end = last * factor;
  if (start < indexEnd || end < start || end > request.size) unsupported('cso-index-range');
  const cache = new Map<number, Buffer>();
  async function frame(index: number): Promise<Buffer> {
    const saved = cache.get(index);
    if (saved) return saved;
    signal?.throwIfAborted();
    const pair = await physical(request, reader, 24 + index * 4, 8, signal),
      value = pair.readUInt32LE(0),
      next = pair.readUInt32LE(4),
      offset = (value & 0x7fffffff) * factor,
      stop = (next & 0x7fffffff) * factor,
      span = stop - offset;
    if (offset < start || stop > end || span < 1 || span > block + factor + 1024)
      unsupported('cso-packet-range');
    let decoded: Buffer;
    if ((value & 0x80000000) !== 0) {
      if (span < block) unsupported('cso-plain-packet-truncated');
      decoded = await physical(request, reader, offset, block, signal);
    } else {
      const packet = await physical(request, reader, offset, span, signal);
      signal?.throwIfAborted();
      let result: { buffer: Buffer; engine: { bytesWritten: number } };
      try {
        result = inflateRawSync(packet, {
          maxOutputLength: block,
          info: true,
        }) as unknown as typeof result;
      } catch {
        unsupported('cso-deflate-invalid');
      }
      decoded = result.buffer;
      const extra = packet.length - result.engine.bytesWritten;
      if (
        decoded.length !== block ||
        extra < 0 ||
        extra >= factor ||
        packet.subarray(result.engine.bytesWritten).some((byte) => byte !== 0)
      )
        unsupported('cso-deflate-size-or-padding');
    }
    signal?.throwIfAborted();
    if (cache.size >= 16) cache.delete(cache.keys().next().value ?? -1);
    cache.set(index, decoded);
    return decoded;
  }
  return {
    size,
    representation: 'psp-cso-logical',
    async read(offset, length) {
      range(offset, length, size);
      const output = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        signal?.throwIfAborted();
        const logical = offset + done,
          index = Math.floor(logical / block),
          within = logical % block,
          take = Math.min(length - done, block - within);
        (await frame(index)).copy(output, done, within, within + take);
        done += take;
      }
      return output;
    },
  };
}

interface IsoEntry {
  lba: number;
  size: number;
  directory: boolean;
}
function isoEntry(record: Buffer, logical: number): IsoEntry {
  if (
    record.length < 34 ||
    record[1] !== 0 ||
    record[26] !== 0 ||
    record[27] !== 0 ||
    ((record[25] ?? 0) & 0x80) !== 0 ||
    record.readUInt16LE(28) !== 1 ||
    record.readUInt16BE(30) !== 1
  )
    unsupported('psp-iso-entry-unsupported');
  const lba = record.readUInt32LE(2),
    size = record.readUInt32LE(10);
  if (
    lba !== record.readUInt32BE(6) ||
    size !== record.readUInt32BE(14) ||
    !size ||
    lba * 2048 + size > logical
  )
    unsupported('psp-iso-entry-range');
  return { lba, size, directory: ((record[25] ?? 0) & 2) !== 0 };
}
async function findIso(
  logical: LogicalRomReader,
  directory: IsoEntry,
  wanted: string,
  signal?: AbortSignal,
): Promise<IsoEntry | null> {
  if (!directory.directory || directory.size > WINDOW) unsupported('psp-iso-directory-limit');
  const bytes = Buffer.from(await logical.read(directory.lba * 2048, directory.size));
  let found: IsoEntry | null = null;
  for (let offset = 0; offset < bytes.length; ) {
    signal?.throwIfAborted();
    const length = bytes[offset] ?? 0;
    if (!length) {
      offset = (Math.floor(offset / 2048) + 1) * 2048;
      continue;
    }
    if (length < 34 || offset + length > bytes.length || (offset % 2048) + length > 2048)
      unsupported('psp-iso-directory-invalid');
    const record = bytes.subarray(offset, offset + length),
      nameLength = record[32] ?? 0;
    if (33 + nameLength > length) unsupported('psp-iso-directory-invalid');
    const name = record
      .toString('ascii', 33, 33 + nameLength)
      .replace(/;1$/, '')
      .toUpperCase();
    if (name === wanted) {
      if (found) unsupported('psp-iso-entry-ambiguous');
      found = isoEntry(record, logical.size);
    }
    offset += length;
  }
  return found;
}
function sfoId(bytes: Buffer): string | null {
  if (
    bytes.length < 20 ||
    bytes.toString('binary', 0, 4) !== '\0PSF' ||
    bytes.readUInt32LE(4) !== 0x101
  )
    unsupported('psp-sfo-header');
  const keys = bytes.readUInt32LE(8),
    data = bytes.readUInt32LE(12),
    count = bytes.readUInt32LE(16);
  if (count > 256 || 20 + count * 16 > keys || keys > data || data > bytes.length)
    unsupported('psp-sfo-index');
  let id: string | null = null;
  for (let n = 0; n < count; n++) {
    const at = 20 + n * 16,
      keyOffset = keys + bytes.readUInt16LE(at),
      format = bytes.readUInt16LE(at + 2),
      length = bytes.readUInt32LE(at + 4),
      maximum = bytes.readUInt32LE(at + 8),
      offset = data + bytes.readUInt32LE(at + 12);
    if (
      keyOffset < keys ||
      keyOffset >= data ||
      length > maximum ||
      offset < data ||
      offset + maximum > bytes.length
    )
      unsupported('psp-sfo-field-range');
    const nul = bytes.indexOf(0, keyOffset);
    if (nul < 0 || nul >= data || nul - keyOffset > 128) unsupported('psp-sfo-key');
    const key = bytes.toString('ascii', keyOffset, nul);
    if (!/^[A-Z0-9_]+$/.test(key)) unsupported('psp-sfo-key');
    if (key === 'DISC_ID') {
      if (id !== null || format !== 0x204 || length < 2 || length > 32)
        unsupported('psp-sfo-id-ambiguous');
      const value = bytes.subarray(offset, offset + length);
      if (value[value.length - 1] !== 0 || value.subarray(0, -1).includes(0))
        unsupported('psp-sfo-id-invalid');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(value.subarray(0, -1));
      if (!/^[A-Z]{4}\d{5}$/.test(text)) unsupported('psp-sfo-id-invalid');
      id = `${text.slice(0, 4)}-${text.slice(4)}`;
    }
  }
  return id;
}
async function pspId(
  logical: LogicalRomReader,
  signal?: AbortSignal,
): Promise<RomIdentifier | null> {
  if (logical.size < 17 * 2048) return null;
  const pvd = Buffer.from(await logical.read(16 * 2048, 2048));
  if (
    pvd[0] !== 1 ||
    pvd.toString('ascii', 1, 6) !== 'CD001' ||
    pvd[6] !== 1 ||
    pvd.readUInt16LE(128) !== 2048 ||
    pvd.readUInt16BE(130) !== 2048
  )
    return null;
  const sectors = pvd.readUInt32LE(80);
  if (sectors !== pvd.readUInt32BE(84) || sectors * 2048 > logical.size || sectors < 17)
    unsupported('psp-iso-volume-range');
  const volumeSize = sectors * 2048;
  const volume: LogicalRomReader = {
    size: volumeSize,
    representation: logical.representation,
    read(offset, length) {
      range(offset, length, volumeSize);
      return logical.read(offset, length);
    },
  };
  const root = isoEntry(pvd.subarray(156, 156 + (pvd[156] ?? 0)), volume.size),
    game = await findIso(volume, root, 'PSP_GAME', signal);
  if (!game?.directory) return null;
  const sfo = await findIso(volume, game, 'PARAM.SFO', signal);
  if (!sfo || sfo.directory || sfo.size > WINDOW) return null;
  const value = sfoId(Buffer.from(await volume.read(sfo.lba * 2048, sfo.size)));
  return value ? { type: 'serial', value, systemId: 'com.provenance.psp', verified: true } : null;
}
const rvzPlugin: IdentificationPlugin = {
  id: RVZ_ID,
  supports: (request) => /\.(rvz|wia)$/i.test(request.name),
  async identify(request, reader, signal) {
    const result = facts(RVZ_ID);
    try {
      const header = await rvzHeader(request, reader, signal);
      if (!header) unsupported('rvz-signature-unsupported');
      const id = discId(header.bytes);
      if (
        !id ||
        (header.discType === 1 && id.systemId !== 'com.provenance.gamecube') ||
        (header.discType === 2 && id.systemId !== 'com.provenance.wii')
      )
        unsupported('rvz-disc-header-conflict');
      result.identifiers.push(id);
    } catch {
      signal?.throwIfAborted();
      result.warnings.push('rvz-header-unsupported-or-invalid');
    }
    return result;
  },
};
const cisoPlugin: IdentificationPlugin = {
  id: CISO_ID,
  supports: (request) => /\.(ciso|cso)$/i.test(request.name),
  async identify(request, reader, signal) {
    const result = facts(CISO_ID);
    try {
      const sparse = await openDolphinCiso(request, reader, signal);
      if (sparse) {
        const id = discId(Buffer.from(await sparse.read(0, 128)));
        if (id) result.identifiers.push(id);
        else result.warnings.push('ciso-disc-id-not-found');
      } else {
        const cso = await openPspCso(request, reader, signal);
        if (!cso) unsupported('ciso-layout-unsupported');
        const id = await pspId(cso, signal);
        if (id) result.identifiers.push(id);
        else result.warnings.push('cso-disc-id-not-found');
      }
    } catch {
      signal?.throwIfAborted();
      result.warnings.push('ciso-layout-unsupported-or-invalid');
    }
    return result;
  },
};
export const dolphinIdentificationPlugins: readonly IdentificationPlugin[] = [
  rvzPlugin,
  cisoPlugin,
];
