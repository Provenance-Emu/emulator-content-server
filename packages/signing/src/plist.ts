/**
 * Property lists, in the two shapes Apple actually ships: the binary form a
 * built `Info.plist` uses and the XML form inside a provisioning profile.
 *
 * The readers are deliberately narrow. Anything outside the types a bundle or a
 * profile is made of is refused rather than guessed at, because a value this
 * code misreads becomes a signing decision made on something that was not said.
 */

export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue };

export class PlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlistError';
  }
}

const BINARY_MAGIC = 'bplist00';

export function parsePlist(bytes: Uint8Array): PlistValue {
  const head = new TextDecoder().decode(bytes.subarray(0, BINARY_MAGIC.length));
  return head === BINARY_MAGIC ? parseBinaryPlist(bytes) : parseXmlPlist(bytes);
}

/** A dictionary at the root, which is the only shape a plist of ours has. */
export function parsePlistDictionary(bytes: Uint8Array): Record<string, PlistValue> {
  const value = parsePlist(bytes);
  if (!isDictionary(value)) throw new PlistError('The property list is not a dictionary');
  return value;
}

export function isDictionary(value: PlistValue): value is Record<string, PlistValue> {
  return (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  );
}

export function requireString(source: Record<string, PlistValue>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') throw new PlistError(`${key} is missing or not a string`);
  return value;
}

export function optionalString(
  source: Record<string, PlistValue>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

export function stringList(source: Record<string, PlistValue>, key: string): string[] {
  const value = source[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PlistError(`${key} is not an array`);
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function requireDate(source: Record<string, PlistValue>, key: string): Date {
  const value = source[key];
  if (!(value instanceof Date)) throw new PlistError(`${key} is missing or not a date`);
  return value;
}

/* ------------------------------------------------------------------ XML ---- */

/** Characters XML gives a name to, which a plist uses for identifiers and paths. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

interface Tag {
  name: string;
  closing: boolean;
  empty: boolean;
}

export function parseXmlPlist(bytes: Uint8Array): PlistValue {
  const text = new TextDecoder().decode(bytes);
  const reader = { text, at: 0 };
  const root = nextTag(reader, 'plist');
  if (!root || root.closing) throw new PlistError('No plist element');
  const value = readXmlValue(reader);
  if (value === null) throw new PlistError('The plist element has no value');
  return value;
}

function readXmlValue(reader: { text: string; at: number }): PlistValue | null {
  const tag = nextTag(reader);
  if (!tag || tag.closing) return null;
  switch (tag.name) {
    case 'dict':
      return tag.empty ? {} : readXmlDictionary(reader);
    case 'array':
      return tag.empty ? [] : readXmlArray(reader);
    case 'true':
      return true;
    case 'false':
      return false;
    case 'string':
      return tag.empty ? '' : decodeEntities(readText(reader, 'string'));
    case 'integer':
      return Number(readText(reader, 'integer').trim());
    case 'real':
      return Number(readText(reader, 'real').trim());
    case 'date':
      return new Date(readText(reader, 'date').trim());
    case 'data':
      return decodeBase64(readText(reader, 'data'));
    default:
      throw new PlistError(`Unsupported plist element ${tag.name}`);
  }
}

function readXmlDictionary(reader: { text: string; at: number }): Record<string, PlistValue> {
  const result: Record<string, PlistValue> = {};
  for (;;) {
    const tag = nextTag(reader);
    if (!tag) throw new PlistError('A dict was never closed');
    if (tag.closing && tag.name === 'dict') return result;
    if (tag.name !== 'key') throw new PlistError(`Expected a key, found ${tag.name}`);
    const key = tag.empty ? '' : decodeEntities(readText(reader, 'key'));
    const value = readXmlValue(reader);
    if (value === null) throw new PlistError(`The key ${key} has no value`);
    result[key] = value;
  }
}

function readXmlArray(reader: { text: string; at: number }): PlistValue[] {
  const result: PlistValue[] = [];
  for (;;) {
    const mark = reader.at;
    const tag = nextTag(reader);
    if (!tag) throw new PlistError('An array was never closed');
    if (tag.closing && tag.name === 'array') return result;
    reader.at = mark;
    const value = readXmlValue(reader);
    if (value === null) throw new PlistError('An array holds something unreadable');
    result.push(value);
  }
}

function nextTag(reader: { text: string; at: number }, expected?: string): Tag | null {
  for (;;) {
    const open = reader.text.indexOf('<', reader.at);
    if (open === -1) return null;
    const close = reader.text.indexOf('>', open);
    if (close === -1) return null;
    const raw = reader.text.slice(open + 1, close);
    reader.at = close + 1;
    // Declarations, doctypes, and comments carry nothing a plist needs.
    if (raw.startsWith('?') || raw.startsWith('!')) continue;
    const closing = raw.startsWith('/');
    const body = closing ? raw.slice(1) : raw;
    const empty = body.endsWith('/');
    const name = (empty ? body.slice(0, -1) : body).trim().split(/\s/)[0] ?? '';
    if (expected && name !== expected) continue;
    return { name, closing, empty };
  }
}

function readText(reader: { text: string; at: number }, name: string): string {
  const end = reader.text.indexOf(`</${name}>`, reader.at);
  if (end === -1) throw new PlistError(`A ${name} was never closed`);
  const value = reader.text.slice(reader.at, end);
  reader.at = end + name.length + 3;
  return value;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.replace(/\s+/g, ''), 'base64'));
}

/* --------------------------------------------------------------- binary ---- */

interface Trailer {
  offsetSize: number;
  referenceSize: number;
  count: number;
  rootReference: number;
  offsetTableStart: number;
}

export function parseBinaryPlist(bytes: Uint8Array): PlistValue {
  if (bytes.length < 40) throw new PlistError('The binary plist is too short to hold a trailer');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailerAt = bytes.length - 32;
  const trailer: Trailer = {
    offsetSize: view.getUint8(trailerAt + 6),
    referenceSize: view.getUint8(trailerAt + 7),
    count: Number(view.getBigUint64(trailerAt + 8)),
    rootReference: Number(view.getBigUint64(trailerAt + 16)),
    offsetTableStart: Number(view.getBigUint64(trailerAt + 24)),
  };
  if (trailer.offsetSize < 1 || trailer.offsetSize > 8 || trailer.referenceSize < 1) {
    throw new PlistError('The binary plist trailer is not usable');
  }
  const offsets: number[] = [];
  for (let index = 0; index < trailer.count; index += 1) {
    offsets.push(
      readSized(view, trailer.offsetTableStart + index * trailer.offsetSize, trailer.offsetSize),
    );
  }
  const seen = new Set<number>();
  return readObject(view, bytes, offsets, trailer, trailer.rootReference, seen);
}

function readObject(
  view: DataView,
  bytes: Uint8Array,
  offsets: number[],
  trailer: Trailer,
  reference: number,
  seen: Set<number>,
): PlistValue {
  const offset = offsets[reference];
  if (offset === undefined) throw new PlistError('A reference points outside the offset table');
  // A plist may share an object but must not contain itself, and a cycle here
  // would otherwise recurse until the stack gives out.
  if (seen.has(reference)) throw new PlistError('The binary plist contains a cycle');
  seen.add(reference);
  const marker = view.getUint8(offset);
  const kind = marker >> 4;
  const extra = marker & 0x0f;
  const child = (next: number): PlistValue =>
    readObject(view, bytes, offsets, trailer, next, new Set(seen));
  switch (kind) {
    case 0x0:
      if (extra === 0x8) return false;
      if (extra === 0x9) return true;
      throw new PlistError(`Unsupported binary plist singleton 0x${extra.toString(16)}`);
    case 0x1:
      return readInteger(view, offset + 1, 2 ** extra);
    case 0x2:
      return extra === 2 ? view.getFloat32(offset + 1) : view.getFloat64(offset + 1);
    case 0x3:
      // Seconds since 2001-01-01, which is Apple's epoch rather than Unix's.
      return new Date((view.getFloat64(offset + 1) + 978_307_200) * 1000);
    case 0x4: {
      const { length, start } = measure(view, offset, extra);
      return bytes.slice(start, start + length);
    }
    case 0x5: {
      const { length, start } = measure(view, offset, extra);
      return new TextDecoder('ascii').decode(bytes.subarray(start, start + length));
    }
    case 0x6: {
      const { length, start } = measure(view, offset, extra);
      return decodeUtf16(view, start, length);
    }
    case 0xa: {
      const { length, start } = measure(view, offset, extra);
      const items: PlistValue[] = [];
      for (let index = 0; index < length; index += 1) {
        items.push(
          child(readSized(view, start + index * trailer.referenceSize, trailer.referenceSize)),
        );
      }
      return items;
    }
    case 0xd: {
      const { length, start } = measure(view, offset, extra);
      const keysAt = start;
      const valuesAt = start + length * trailer.referenceSize;
      const result: Record<string, PlistValue> = {};
      for (let index = 0; index < length; index += 1) {
        const key = child(
          readSized(view, keysAt + index * trailer.referenceSize, trailer.referenceSize),
        );
        if (typeof key !== 'string') throw new PlistError('A dictionary key is not a string');
        result[key] = child(
          readSized(view, valuesAt + index * trailer.referenceSize, trailer.referenceSize),
        );
      }
      return result;
    }
    default:
      throw new PlistError(`Unsupported binary plist type 0x${kind.toString(16)}`);
  }
}

/**
 * Length and payload start for the types that carry a count. A count of 15 in
 * the marker means the real count follows as its own integer object.
 */
function measure(view: DataView, offset: number, extra: number): { length: number; start: number } {
  if (extra !== 0x0f) return { length: extra, start: offset + 1 };
  const marker = view.getUint8(offset + 1);
  if (marker >> 4 !== 0x1) throw new PlistError('A long count is not an integer');
  const width = 2 ** (marker & 0x0f);
  const length = readInteger(view, offset + 2, width);
  if (typeof length !== 'number') throw new PlistError('A long count is not representable');
  return { length, start: offset + 2 + width };
}

function readInteger(view: DataView, offset: number, width: number): number {
  if (width === 1) return view.getUint8(offset);
  if (width === 2) return view.getUint16(offset);
  if (width === 4) return view.getUint32(offset);
  if (width === 8) return Number(view.getBigInt64(offset));
  if (width === 16) return Number(view.getBigInt64(offset + 8));
  throw new PlistError(`Unsupported integer width ${width}`);
}

function readSized(view: DataView, offset: number, size: number): number {
  let value = 0;
  for (let index = 0; index < size; index += 1) value = value * 256 + view.getUint8(offset + index);
  return value;
}

function decodeUtf16(view: DataView, start: number, length: number): string {
  const units = new Array<number>(length);
  for (let index = 0; index < length; index += 1) units[index] = view.getUint16(start + index * 2);
  return String.fromCharCode(...units);
}
