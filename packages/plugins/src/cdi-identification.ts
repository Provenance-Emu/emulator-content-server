import type { RomFacts } from './rom-facts.js';
import type {
  IdentificationPlugin,
  IdentificationRequest,
  ReaderContext,
} from './rom-identification.js';

const V2 = 0x80000004,
  V3 = 0x80000005,
  V35 = 0x80000006;
const mark = Buffer.from([0, 0, 1, 0, 0, 0, 255, 255, 255, 255]);
interface Track {
  offset: number;
  sector: number;
  mode: number;
}
function invalid(): never {
  throw new Error('cdi-layout-unsupported');
}
/** DiscJuggler descriptor fields documented by Flycast core/deps/chdpsr/cdipsr.cpp.
 * Only the bounded track table and first sector of each data track are read.
 * No conversion, audio scan, full-image checksum, or executable code is involved. */
async function tracks(
  request: IdentificationRequest,
  reader: ReaderContext,
  signal?: AbortSignal,
): Promise<Track[]> {
  signal?.throwIfAborted();
  if (request.size < 12) invalid();
  const footer = Buffer.from(await reader.read(request.size - 8, 8));
  const version = footer.readUInt32LE(0),
    pointer = footer.readUInt32LE(4);
  if (![V2, V3, V35].includes(version) || !pointer) invalid();
  const start = version === V35 ? request.size - pointer : pointer,
    length = request.size - 8 - start;
  if (start < 1 || length < 4 || length > 1024 * 1024) invalid();
  signal?.throwIfAborted();
  const table = Buffer.from(await reader.read(start, length));
  let at = 0,
    physical = 0,
    totalTracks = 0;
  const take = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0 || at + n > table.length) invalid();
    const value = table.subarray(at, at + n);
    at += n;
    return value;
  };
  const u16 = () => take(2).readUInt16LE(),
    u32 = () => take(4).readUInt32LE();
  const sessions = u16();
  if (sessions < 1 || sessions > 32) invalid();
  const result: Track[] = [];
  for (let session = 0; session < sessions; session++) {
    signal?.throwIfAborted();
    const count = u16();
    totalTracks += count;
    if (count > 100 || totalTracks > 128) invalid();
    for (let index = 0; index < count; index++) {
      if (u32() !== 0) take(8);
      if (!take(10).equals(mark) || !take(10).equals(mark)) invalid();
      take(4);
      take(take(1)[0] ?? 0);
      take(19);
      if (u32() === 0x80000000) take(8);
      take(2);
      const pregap = u32(),
        frames = u32();
      take(6);
      const mode = u32();
      take(12);
      const lba = u32(),
        total = u32();
      take(16);
      const code = u32();
      const sector = ({ 0: 2048, 1: 2336, 2: 2352, 4: 2448 } as Record<number, number>)[code];
      if (
        !sector ||
        mode > 2 ||
        frames < 1 ||
        total < pregap + frames ||
        lba > 0x1000000 ||
        total > 0x1000000 ||
        physical + total * sector > start
      )
        invalid();
      if (mode !== 0) result.push({ offset: physical + pregap * sector, sector, mode });
      physical += total * sector;
      take(29);
      if (version !== V2) {
        take(5);
        if (u32() === 0xffffffff) take(78);
      }
    }
    take(version === V2 ? 12 : 13);
  }
  if (!totalTracks || !result.length) invalid();
  return result;
}
function payload(bytes: Buffer, track: Track): Buffer | null {
  if (track.sector === 2048) return track.mode === 1 ? bytes : null;
  if (track.sector === 2336) {
    if (
      track.mode !== 2 ||
      !bytes.subarray(0, 4).equals(bytes.subarray(4, 8)) ||
      (bytes[2] ?? 0) & 0x20
    )
      return null;
    return bytes.subarray(8, 2056);
  }
  if (
    bytes[0] !== 0 ||
    !bytes.subarray(1, 11).every((b) => b === 255) ||
    bytes[11] !== 0 ||
    bytes[15] !== track.mode
  )
    return null;
  if (track.mode === 1) return bytes.subarray(16, 2064);
  if (!bytes.subarray(16, 20).equals(bytes.subarray(20, 24)) || (bytes[18] ?? 0) & 0x20)
    return null;
  return bytes.subarray(24, 2072);
}
function field(bytes: Buffer): string {
  const text = bytes.toString('ascii');
  if (bytes.some((b) => b < 32 || b > 126)) return '';
  return text.trim();
}
export const cdiIdentificationPlugin: IdentificationPlugin = {
  id: 'org.ecs.identify.cdi',
  supports: (r) => /\.cdi$/i.test(r.name),
  async identify(request, reader, signal) {
    const result: RomFacts = {
      version: 1,
      pluginIds: [],
      hashes: [],
      identifiers: [],
      names: [],
      warnings: [],
    };
    if (request.systemId && request.systemId !== 'com.provenance.dreamcast') {
      result.warnings.push('cdi-system-conflict');
      return result;
    }
    const layout = await tracks(request, reader, signal);
    for (const track of layout) {
      signal?.throwIfAborted();
      const bytes = payload(Buffer.from(await reader.read(track.offset, track.sector)), track);
      if (!bytes?.subarray(0, 16).equals(Buffer.from('SEGA SEGAKATANA '))) continue;
      const serial = field(bytes.subarray(0x40, 0x4a)).toUpperCase();
      if (!/^[A-Z0-9]{1,6}-[A-Z0-9]{3,10}$/.test(serial)) continue;
      if (!result.identifiers.some((id) => id.value === serial))
        result.identifiers.push({
          type: 'serial',
          value: serial,
          systemId: /^(?:GD|GDL|GDS|CDV)-/.test(serial) ? null : 'com.provenance.dreamcast',
          verified: true,
        });
      const title = field(bytes.subarray(0x80, 0x100));
      if (title && !result.names.includes(title)) result.names.push(title);
      if (result.identifiers.length > 16) invalid();
    }
    if (!result.identifiers.length) result.warnings.push('cdi-no-disc-identifier');
    return result;
  },
};
