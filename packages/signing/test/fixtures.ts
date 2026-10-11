import { deflateRawSync } from 'node:zlib';

/**
 * Archives and property lists built here rather than committed, because a real
 * IPA carries someone's app and a real profile carries someone's certificate.
 */

export interface PlannedEntry {
  name: string;
  bytes: Uint8Array;
  /** Stored rather than deflated, which is how a reader's other path is covered. */
  stored?: boolean;
}

export function zip(entries: PlannedEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.bytes);
    const payload = entry.stored ? raw : deflateRawSync(raw);
    const method = entry.stored ? 0 : 8;
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, payload);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export interface BundleDescription {
  bundleId: string;
  name?: string;
  executable?: string;
  platforms?: string[];
  version?: string;
  profile?: Uint8Array;
  /** Written as a binary plist, which is what a built app actually contains. */
  binaryInfo?: boolean;
}

export function ipa(description: BundleDescription): Buffer {
  const app = `Payload/${description.name ?? 'Probe'}.app/`;
  const info: Record<string, unknown> = {
    CFBundleIdentifier: description.bundleId,
    CFBundleName: description.name ?? 'Probe',
    CFBundleExecutable: description.executable ?? description.name ?? 'Probe',
    CFBundleShortVersionString: description.version ?? '1.0',
    CFBundleVersion: '1',
    MinimumOSVersion: '16.0',
    CFBundleSupportedPlatforms: description.platforms ?? ['iPhoneOS'],
  };
  const entries: PlannedEntry[] = [
    {
      name: `${app}Info.plist`,
      bytes: description.binaryInfo ? binaryPlist(info) : xmlPlist(info),
    },
    { name: `${app}${description.executable ?? description.name ?? 'Probe'}`, bytes: pattern(512) },
  ];
  if (description.profile) {
    entries.push({
      name: `${app}embedded.mobileprovision`,
      bytes: description.profile,
      stored: true,
    });
  }
  return zip(entries);
}

export interface ProfileDescription {
  name?: string;
  uuid?: string;
  teamId?: string;
  bundleIdPattern?: string;
  devices?: string[];
  expiresAt?: Date;
  debugging?: boolean;
}

/** An XML plist inside bytes that stand in for the CMS wrapper around it. */
export function mobileprovision(description: ProfileDescription = {}): Uint8Array {
  const teamId = description.teamId ?? 'ABCDE12345';
  const pattern = description.bundleIdPattern ?? 'com.provenance.probe';
  const plist = xmlPlist({
    Name: description.name ?? 'Probe Development',
    UUID: description.uuid ?? '11111111-2222-3333-4444-555555555555',
    ProvisionedDevices: description.devices ?? ['00008030-001122334455667788'],
    ExpirationDate: description.expiresAt ?? new Date(Date.now() + 7 * 86_400_000),
    Entitlements: {
      'application-identifier': `${teamId}.${pattern}`,
      'com.apple.developer.team-identifier': teamId,
      'get-task-allow': description.debugging ?? true,
    },
  });
  const head = Buffer.from('0\u0082signed-data-wrapper\u0000', 'latin1');
  const tail = Buffer.from('\u0000signature-bytes', 'latin1');
  return new Uint8Array(Buffer.concat([head, Buffer.from(plist), tail]));
}

export function xmlPlist(value: unknown): Uint8Array {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">${xmlValue(value)}</plist>`;
  return new Uint8Array(Buffer.from(body, 'utf8'));
}

function xmlValue(value: unknown): string {
  if (typeof value === 'string') return `<string>${escapeXml(value)}</string>`;
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
  }
  if (value instanceof Date) return `<date>${value.toISOString().replace(/\.\d+Z$/, 'Z')}</date>`;
  if (value instanceof Uint8Array) {
    return `<data>${Buffer.from(value).toString('base64')}</data>`;
  }
  if (Array.isArray(value)) return `<array>${value.map(xmlValue).join('')}</array>`;
  if (value && typeof value === 'object') {
    const pairs = Object.entries(value).map(
      ([key, entry]) => `<key>${escapeXml(key)}</key>${xmlValue(entry)}`,
    );
    return `<dict>${pairs.join('')}</dict>`;
  }
  throw new Error(`No plist form for ${String(value)}`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A minimal binary plist writer, enough for the dictionaries an `Info.plist`
 * holds. Written here so the reader is exercised against the real format rather
 * than against its own output of the XML path.
 */
export function binaryPlist(value: unknown): Uint8Array {
  const objects: Buffer[] = [];
  const references = new Map<unknown, number>();

  const add = (entry: unknown): number => {
    if (typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'number') {
      const existing = references.get(entry);
      if (existing !== undefined) return existing;
    }
    const index = objects.length;
    objects.push(Buffer.alloc(0));
    if (typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'number') {
      references.set(entry, index);
    }
    objects[index] = encode(entry, add);
    return index;
  };

  const root = add(value);
  const header = Buffer.from('bplist00', 'latin1');
  const offsets: number[] = [];
  let at = header.length;
  for (const object of objects) {
    offsets.push(at);
    at += object.length;
  }
  const table = Buffer.alloc(offsets.length * 4);
  offsets.forEach((offset, index) => {
    table.writeUInt32BE(offset, index * 4);
  });
  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(4, 6);
  trailer.writeUInt8(4, 7);
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(root), 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return new Uint8Array(Buffer.concat([header, ...objects, table, trailer]));
}

function encode(value: unknown, add: (entry: unknown) => number): Buffer {
  if (typeof value === 'boolean') return Buffer.from([value ? 0x09 : 0x08]);
  if (typeof value === 'number') {
    const bytes = Buffer.alloc(9);
    bytes.writeUInt8(0x13, 0);
    bytes.writeBigInt64BE(BigInt(Math.trunc(value)), 1);
    return bytes;
  }
  if (typeof value === 'string') {
    const ascii = Buffer.from(value, 'ascii');
    return Buffer.concat([marker(0x50, ascii.length), ascii]);
  }
  if (value instanceof Date) {
    const bytes = Buffer.alloc(9);
    bytes.writeUInt8(0x33, 0);
    bytes.writeDoubleBE(value.getTime() / 1000 - 978_307_200, 1);
    return bytes;
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([marker(0x40, value.length), Buffer.from(value)]);
  }
  if (Array.isArray(value)) {
    const items = value.map((entry) => add(entry));
    return Buffer.concat([marker(0xa0, items.length), references(items)]);
  }
  if (value && typeof value === 'object') {
    const pairs = Object.entries(value);
    const keys = pairs.map(([key]) => add(key));
    const values = pairs.map(([, entry]) => add(entry));
    return Buffer.concat([marker(0xd0, pairs.length), references(keys), references(values)]);
  }
  throw new Error(`No binary plist form for ${String(value)}`);
}

function marker(kind: number, count: number): Buffer {
  if (count < 0x0f) return Buffer.from([kind | count]);
  const bytes = Buffer.alloc(6);
  bytes.writeUInt8(kind | 0x0f, 0);
  bytes.writeUInt8(0x12, 1);
  bytes.writeUInt32BE(count, 2);
  return bytes;
}

function references(indexes: number[]): Buffer {
  const bytes = Buffer.alloc(indexes.length * 4);
  indexes.forEach((index, at) => {
    bytes.writeUInt32BE(index, at * 4);
  });
  return bytes;
}

export function pattern(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
  return bytes;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}
