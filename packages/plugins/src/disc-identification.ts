import type { RomFacts } from './rom-facts.js';
import type { IdentificationPlugin, IdentificationRequest } from './rom-identification.js';

const MAX_DESCRIPTOR = 64 * 1024,
  MAX_MEMBERS = 128,
  MAX_TRACKS = 99,
  MAX_DATA = 8;
const PSX = 'com.provenance.psx',
  PS2 = 'com.provenance.ps2',
  DC = 'com.provenance.dreamcast';
type Member = NonNullable<IdentificationRequest['media']>['members'][number];
interface Track {
  number: number;
  member: Member;
  sector: number;
  mode: 0 | 1 | 2 | 'raw';
  offset: number;
  end: number;
  isoOrigin: boolean;
}
function invalid(code = 'disc-layout-unsupported'): never {
  throw new Error(code);
}
function integer(value: string): number {
  if (!/^\d+$/.test(value)) invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > 0xffffffff) invalid();
  return number;
}
function hasControl(value: string, allowWhitespace = false): boolean {
  return Array.from(value).some((character) => {
    const byte = character.charCodeAt(0);
    return (byte < 32 && !(allowWhitespace && [9, 10, 13].includes(byte))) || byte === 127;
  });
}
function canonical(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 4096 &&
    !/[\\:]/.test(name) &&
    !hasControl(name) &&
    !name.startsWith('/') &&
    name.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
function reference(name: string, entry: string): string {
  const value = name.replaceAll('\\', '/');
  if (!value || value.startsWith('/') || value.includes(':') || hasControl(value))
    invalid('disc-reference-unsafe');
  const parts = entry.split('/').slice(0, -1);
  for (const part of value.split('/')) {
    if (part === '..') {
      if (!parts.length) invalid('disc-reference-unsafe');
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  const result = parts.join('/');
  if (!canonical(result)) invalid('disc-reference-unsafe');
  return result;
}
function members(request: IdentificationRequest): (name: string) => Member {
  const media = request.media;
  if (
    !media ||
    !canonical(media.entry) ||
    !Array.isArray(media.members) ||
    !media.members.length ||
    media.members.length > MAX_MEMBERS
  )
    invalid('disc-member-context-required');
  const available = new Map<string, Member>();
  for (const member of media.members) {
    if (!member || !canonical(member.name) || !Number.isSafeInteger(member.size) || member.size < 1)
      invalid('disc-member-invalid');
    const key = member.name.toLowerCase();
    if (available.has(key)) invalid('disc-member-ambiguous');
    available.set(key, member);
  }
  return (name) => {
    const path = reference(name, media.entry);
    if (path.toLowerCase() === media.entry.toLowerCase()) invalid('disc-member-self-reference');
    const member = available.get(path.toLowerCase());
    if (!member) invalid('disc-member-missing');
    return member;
  };
}
function timestamp(value: string): number {
  const match = /^(\d{1,3}):([0-5]\d):([0-7]\d)$/.exec(value);
  if (!match || Number(match[3]) >= 75) invalid();
  return Number(match[1]) * 60 * 75 + Number(match[2]) * 75 + Number(match[3]);
}
/** CUE offsets are file-relative INDEX positions. A PREGAP creates silence; it
 * never advances the file offset. Mixed-size shared BINs have no safe mapping. */
function cueTracks(text: string, resolve: (name: string) => Member): Track[] {
  interface CueTrack extends Track {
    indexes: Map<number, number>;
    pregap?: number;
    postgap?: number;
    session: number;
  }
  const tracks: CueTrack[] = [];
  let file: Member | undefined,
    track: CueTrack | undefined,
    session = 1;
  for (const source of text.split(/\r\n?|\n/)) {
    const line = source.trim();
    if (!line || line.startsWith(';')) continue;
    if (/^REM\b/i.test(line)) {
      if (/^REM\s+SESSION\b/i.test(line)) {
        const match = /^REM\s+SESSION\s+(\d{1,2})$/i.exec(line);
        if (!match || Number(match[1]) < session || Number(match[1]) > 99 || Number(match[1]) < 1)
          invalid();
        session = Number(match[1]);
      }
      continue;
    }
    if (/^FILE\b/i.test(line)) {
      const match = /^FILE\s+(?:"([^"]+)"|([^"\r\n]+?))\s+BINARY$/i.exec(line);
      if (!match) invalid('cue-binary-members-required');
      file = resolve(match[1] ?? match[2] ?? '');
      track = undefined;
    } else if (/^TRACK\b/i.test(line)) {
      const match =
        /^TRACK\s+(\d{1,2})\s+(AUDIO|MODE1\/2048|MODE1\/2352|MODE2\/2352|MODE2\/2336)$/i.exec(line);
      if (!match || !file || Number(match[1]) !== tracks.length + 1 || tracks.length >= MAX_TRACKS)
        invalid();
      const type = (match[2] ?? '').toUpperCase();
      const sector = type === 'AUDIO' ? 2352 : Number(type.split('/')[1]);
      const mode = type === 'AUDIO' ? 0 : type.startsWith('MODE1') ? 1 : 2;
      track = {
        number: tracks.length + 1,
        member: file,
        sector,
        mode,
        offset: 0,
        end: 0,
        isoOrigin: tracks.length === 0 && session === 1,
        indexes: new Map(),
        session,
      };
      tracks.push(track);
    } else if (/^INDEX\b/i.test(line)) {
      const match = /^INDEX\s+(\d{1,2})\s+(\d{1,3}:\d{2}:\d{2})$/i.exec(line);
      if (!match || !track) invalid();
      const index = Number(match[1]),
        position = timestamp(match[2] ?? '');
      const previous = [...track.indexes.entries()].at(-1);
      if (
        track.indexes.has(index) ||
        (previous && (index <= previous[0] || position < previous[1]))
      )
        invalid();
      track.indexes.set(index, position);
    } else if (/^(?:PRE|POST)GAP\b/i.test(line)) {
      const match = /^(PREGAP|POSTGAP)\s+(\d{1,3}:\d{2}:\d{2})$/i.exec(line);
      if (!match || !track) invalid();
      const key = match[1]?.toUpperCase() === 'PREGAP' ? 'pregap' : 'postgap';
      if (track[key] !== undefined) invalid();
      track[key] = timestamp(match[2] ?? '');
    } else if (!/^(?:TITLE|PERFORMER|SONGWRITER|CATALOG|ISRC|FLAGS)\b/i.test(line)) invalid();
  }
  if (!tracks.length || tracks.filter((t) => t.mode !== 0).length > MAX_DATA)
    invalid('disc-track-limit');
  for (let n = 0; n < tracks.length; n++) {
    const current = tracks[n];
    if (!current) invalid();
    const index = current.indexes.get(1);
    if (index === undefined || current.member.size % current.sector) invalid();
    const shared = tracks.filter((candidate) => candidate.member.name === current.member.name);
    if (shared.some((candidate) => candidate.sector !== current.sector))
      invalid('cue-shared-sector-layout-unsupported');
    const next = tracks
      .slice(n + 1)
      .find((candidate) => candidate.member.name === current.member.name);
    current.offset = index * current.sector;
    const nextIndex = next ? (next.indexes.get(0) ?? next.indexes.get(1)) : undefined;
    if (next && nextIndex === undefined) invalid();
    current.end = nextIndex === undefined ? current.member.size : nextIndex * current.sector;
    if (
      current.offset + current.sector > current.end ||
      current.end > current.member.size ||
      [...current.indexes.values()].some(
        (value) => value * current.sector < 0 || value * current.sector >= current.end,
      )
    )
      invalid();
    if (
      n > 0 &&
      shared.includes(tracks[n - 1] as CueTrack) &&
      current.offset <= (tracks[n - 1]?.offset ?? 0)
    )
      invalid();
  }
  return tracks;
}
/** Flycast imgread/gdi.cpp defines the six fields and file-relative byte offset.
 * Disc LBAs locate tracks; they are never multiplied into an individual file. */
function gdiTracks(text: string, resolve: (name: string) => Member): Track[] {
  const lines = text
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const count = integer(lines.shift() ?? '');
  if (count < 1 || count > MAX_TRACKS || lines.length !== count) invalid('disc-track-limit');
  const tracks: (Track & { lba: number })[] = [];
  for (const line of lines) {
    const match =
      /^(\d+)\s+(\d+)\s+([04])\s+(2048|2336|2352)\s+(?:"([^"]+)"|([^"\r\n]+?))\s+(\d+)$/.exec(line);
    if (!match) invalid();
    const number = integer(match[1] ?? ''),
      lba = integer(match[2] ?? ''),
      type = Number(match[3]),
      sector = Number(match[4]);
    const member = resolve(match[5] ?? match[6] ?? ''),
      offset = integer(match[7] ?? '');
    if (
      number !== tracks.length + 1 ||
      (type === 0 && sector !== 2352) ||
      offset + sector > member.size ||
      (member.size - offset) % sector
    )
      invalid();
    const previous = tracks.at(-1);
    if (previous && previous.lba >= lba) invalid();
    tracks.push({
      number,
      member,
      sector,
      mode: type === 0 ? 0 : sector === 2048 ? 1 : sector === 2336 ? 2 : 'raw',
      offset,
      end: member.size,
      isoOrigin: false,
      lba,
    });
  }
  if (tracks.filter((t) => t.mode !== 0).length > MAX_DATA) invalid('disc-track-limit');
  for (let n = 0; n < tracks.length; n++) {
    const current = tracks[n];
    if (!current) invalid();
    const nextFile = tracks
      .slice(n + 1)
      .find((candidate) => candidate.member.name === current.member.name);
    if (nextFile) {
      if (nextFile.sector !== current.sector || nextFile.offset <= current.offset) invalid();
      current.end = nextFile.offset;
    }
    if ((current.end - current.offset) % current.sector) invalid();
    const next = tracks[n + 1];
    if (next && (current.end - current.offset) / current.sector > next.lba - current.lba) invalid();
  }
  return tracks;
}
function payload(bytes: Buffer, track: Track): Buffer {
  if (bytes.length !== track.sector) invalid('disc-sector-truncated');
  if (track.sector === 2048) return bytes;
  if (track.sector === 2336) {
    if (
      track.mode !== 2 ||
      !bytes.subarray(0, 4).equals(bytes.subarray(4, 8)) ||
      (bytes[2] ?? 0) & 0x20
    )
      invalid('disc-sector-invalid');
    return bytes.subarray(8, 2056);
  }
  if (
    bytes[0] !== 0 ||
    !bytes.subarray(1, 11).equals(Buffer.alloc(10, 255)) ||
    bytes[11] !== 0 ||
    ![1, 2].includes(bytes[15] ?? 0) ||
    (track.mode !== 'raw' && bytes[15] !== track.mode)
  )
    invalid('disc-sector-invalid');
  // Sync + exact mode and duplicated XA Form 1 subheader establish the payload.
  if (bytes[15] === 1) return bytes.subarray(16, 2064);
  if (!bytes.subarray(16, 20).equals(bytes.subarray(20, 24)) || (bytes[18] ?? 0) & 0x20)
    invalid('disc-sector-invalid');
  return bytes.subarray(24, 2072);
}
function ascii(bytes: Buffer): string {
  if (bytes.some((byte) => byte < 32 || byte > 126)) return '';
  return bytes.toString('ascii').trim();
}
function addIdentifier(result: RomFacts, value: string, systemId: string | null) {
  if (!result.identifiers.some((id) => id.value === value && id.systemId === systemId))
    result.identifiers.push({ type: 'serial', value, systemId, verified: true });
}
function dreamcast(bytes: Buffer, result: RomFacts): boolean {
  if (!bytes.subarray(0, 16).equals(Buffer.from('SEGA SEGAKATANA '))) return false;
  const serial = ascii(bytes.subarray(0x40, 0x4a)).toUpperCase();
  if (!/^[A-Z0-9]{1,6}-[A-Z0-9]{3,10}$/.test(serial)) return false;
  addIdentifier(result, serial, /^(?:GD|GDL|GDS|CDV)-/.test(serial) ? null : DC);
  const title = ascii(bytes.subarray(0x80, 0x100));
  if (title && !result.names.includes(title)) result.names.push(title);
  return true;
}
function twin32(bytes: Buffer, at: number): number {
  const value = bytes.readUInt32LE(at);
  if (value !== bytes.readUInt32BE(at + 4)) invalid('disc-iso-endian-mismatch');
  return value;
}
function twin16(bytes: Buffer, at: number): number {
  const value = bytes.readUInt16LE(at);
  if (value !== bytes.readUInt16BE(at + 2)) invalid('disc-iso-endian-mismatch');
  return value;
}
interface Extent {
  lba: number;
  size: number;
}
function directoryRecord(bytes: Buffer, volume: number): Extent {
  if (
    bytes.length < 34 ||
    bytes[0] !== bytes.length ||
    bytes[1] !== 0 ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    twin16(bytes, 28) !== 1
  )
    invalid('disc-iso-directory-invalid');
  const lba = twin32(bytes, 2),
    size = twin32(bytes, 10);
  if (
    lba >= volume ||
    size > volume * 2048 ||
    lba + Math.ceil(size / 2048) > volume ||
    (bytes[32] ?? 0) < 1 ||
    33 + (bytes[32] ?? 0) > bytes.length
  )
    invalid('disc-iso-extent-invalid');
  return { lba, size };
}
/** ECMA-119 7.2/7.3 endian twins, 8.4 PVD and 9.1 directory records.
 * Only a known track-01 ISO origin is read; secondary-track rebasing is refused. */
async function isoSerial(
  track: Track,
  read: (track: Track, sector: number) => Promise<Buffer>,
  result: RomFacts,
): Promise<void> {
  if ((track.end - track.offset) / track.sector < 17) return;
  const pvd = await read(track, 16);
  if (!pvd.subarray(0, 7).equals(Buffer.from([1, ...Buffer.from('CD001'), 1]))) return;
  const volume = twin32(pvd, 80);
  if (
    !volume ||
    volume > (track.end - track.offset) / track.sector ||
    twin16(pvd, 120) !== 1 ||
    twin16(pvd, 124) !== 1 ||
    twin16(pvd, 128) !== 2048
  )
    invalid('disc-iso-volume-invalid');
  const rootRecord = pvd.subarray(156, 190);
  if (rootRecord[0] !== 34 || rootRecord[25] !== 2 || rootRecord[32] !== 1 || rootRecord[33] !== 0)
    invalid('disc-iso-root-invalid');
  const root = directoryRecord(rootRecord, volume);
  if (root.lba < 17 || root.size < 34 || root.size > 65536) invalid('disc-iso-root-limit');
  const readExtent = async (extent: Extent) => {
    const parts: Buffer[] = [];
    for (let n = 0; n < Math.ceil(extent.size / 2048); n++)
      parts.push(await read(track, extent.lba + n));
    return Buffer.concat(parts).subarray(0, extent.size);
  };
  const directory = await readExtent(root);
  let config: Extent | undefined;
  for (let at = 0; at < directory.length; ) {
    const length = directory[at] ?? 0;
    if (!length) {
      at = (Math.floor(at / 2048) + 1) * 2048;
      continue;
    }
    if (length < 34 || at + length > directory.length || (at % 2048) + length > 2048)
      invalid('disc-iso-directory-invalid');
    const record = directory.subarray(at, at + length),
      extent = directoryRecord(record, volume);
    const nameBytes = record.subarray(33, 33 + (record[32] ?? 0));
    const name = ascii(nameBytes).toUpperCase();
    if (name === 'SYSTEM.CNF;1' || name === 'SYSTEM.CNF') {
      if (
        config ||
        !extent.size ||
        extent.size > 8192 ||
        extent.lba < 17 ||
        (record[25] ?? 0) & 0x86
      )
        invalid('disc-iso-configuration-invalid');
      config = extent;
    }
    at += length;
  }
  if (!config) return;
  const bytes = await readExtent(config);
  if (bytes.some((byte) => byte > 126 || (byte < 32 && ![9, 10, 13].includes(byte))))
    invalid('disc-iso-configuration-invalid');
  for (const line of bytes.toString('ascii').split(/\r\n?|\n/)) {
    const match =
      /^\s*(BOOT2?)\s*=\s*(?:cdrom(?::|0:))[/\\]([A-Z]{4})[_-](\d{3})\.(\d{2})(?:;1)?\s*$/i.exec(
        line,
      );
    if (!match) {
      if (/^\s*BOOT2?\b/i.test(line)) invalid('disc-iso-boot-unsupported');
      continue;
    }
    const ps2 = match[1]?.toUpperCase() === 'BOOT2';
    // The BOOT key and the device prefix must agree; do not invent a platform.
    if (ps2 ? !/cdrom0:/i.test(line) : !/cdrom:/i.test(line)) invalid('disc-iso-boot-unsupported');
    addIdentifier(result, `${match[2]?.toUpperCase()}-${match[3]}${match[4]}`, ps2 ? PS2 : PSX);
  }
}
function facts(): RomFacts {
  return { version: 1, pluginIds: [], hashes: [], identifiers: [], names: [], warnings: [] };
}
function plugin(format: 'cue' | 'gdi'): IdentificationPlugin {
  return {
    id: `org.ecs.identify.${format}`,
    supports: (request) => new RegExp(`\\.${format}$`, 'i').test(request.name),
    async identify(request, reader, signal) {
      const result = facts();
      try {
        signal?.throwIfAborted();
        const readMember = reader.readMember;
        if (!readMember) invalid('disc-member-context-required');
        const resolve = members(request);
        if (
          !Number.isSafeInteger(request.size) ||
          request.size < 1 ||
          request.size > MAX_DESCRIPTOR
        )
          invalid('disc-descriptor-limit');
        const descriptor = await reader.read(0, request.size);
        signal?.throwIfAborted();
        if (descriptor.length !== request.size) invalid('disc-descriptor-truncated');
        const text = new TextDecoder('utf-8', { fatal: true })
          .decode(descriptor)
          .replace(/^\uFEFF/, '');
        if (hasControl(text, true)) invalid('disc-descriptor-invalid');
        const tracks = format === 'cue' ? cueTracks(text, resolve) : gdiTracks(text, resolve);
        let consumed = descriptor.length;
        const read = async (track: Track, sector: number): Promise<Buffer> => {
          signal?.throwIfAborted();
          const offset = track.offset + sector * track.sector;
          const total = consumed + track.sector;
          if (
            !Number.isSafeInteger(sector) ||
            sector < 0 ||
            !Number.isSafeInteger(offset) ||
            offset + track.sector > track.end ||
            total > 256 * 1024
          )
            invalid('disc-sector-range-limit');
          consumed = total;
          const bytes = Buffer.from(await readMember(track.member.name, offset, track.sector));
          signal?.throwIfAborted();
          return payload(bytes, track);
        };
        let incompatible = false;
        for (const track of tracks.filter((candidate) => candidate.mode !== 0)) {
          const first = await read(track, 0);
          if (dreamcast(first, result)) {
            if (request.systemId && request.systemId !== DC) incompatible = true;
          } else if (format === 'cue') {
            if (track.isoOrigin) await isoSerial(track, read, result);
            else if (!result.warnings.includes('cue-secondary-track-iso-origin-unsupported'))
              result.warnings.push('cue-secondary-track-iso-origin-unsupported');
          }
        }
        if (
          request.systemId &&
          result.identifiers.some((id) => id.systemId && id.systemId !== request.systemId)
        )
          incompatible = true;
        if (incompatible) {
          // Preserve stronger contradictory evidence for matching's fallback guards.
          // The observed system is never replaced by the requested catalog system.
          result.names = [];
          result.warnings.push('disc-system-conflict');
        }
        if (result.identifiers.length > 1) result.warnings.push('disc-identifiers-conflict');
        if (!result.identifiers.length)
          result.warnings.push(
            request.systemId === 'com.provenance.jaguarcd'
              ? 'cue-jaguarcd-requires-catalog-or-explicit-match'
              : `${format}-no-bounded-disc-identifier`,
          );
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        const code =
          error instanceof Error &&
          /^disc-|^cue-/.test(error.message) &&
          /^[a-z0-9-]+$/.test(error.message)
            ? error.message
            : 'disc-reader-or-layout-unavailable';
        return { ...facts(), warnings: [code] };
      }
    },
  };
}
export const discIdentificationPlugins: IdentificationPlugin[] = [plugin('cue'), plugin('gdi')];
