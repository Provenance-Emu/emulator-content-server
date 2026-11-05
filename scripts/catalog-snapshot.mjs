import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

const MAX_BYTES = 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function validatePin(pin) {
  if (
    !pin ||
    !Number.isSafeInteger(pin.bytes) ||
    pin.bytes <= 0 ||
    pin.bytes > MAX_BYTES ||
    !/^[a-f0-9]{64}$/.test(pin.sha256 ?? '') ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,199}$/.test(pin.filename ?? '')
  )
    throw new Error('Invalid bounded metadata snapshot pin');
}
async function fetchBounded(fetcher, url, expected) {
  const response = await fetcher(url, {
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok || !response.body) throw new Error(`Metadata snapshot HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > expected) throw new Error('Metadata snapshot exceeds pinned byte limit');
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, length);
}
function extractDat(archive, pin) {
  // This format is deliberately limited to one pinned, unencrypted local ZIP entry.
  // No archive paths are written or followed; the complete archive digest is checked first.
  if (
    archive.length < 30 ||
    archive.readUInt32LE(0) !== 0x04034b50 ||
    archive.readUInt16LE(6) !== 0
  )
    throw new Error('Unsupported snapshot ZIP header');
  const method = archive.readUInt16LE(8);
  const compressed = archive.readUInt32LE(18);
  const expanded = archive.readUInt32LE(22);
  const nameLength = archive.readUInt16LE(26);
  const start = 30 + nameLength + archive.readUInt16LE(28);
  if (
    expanded !== pin.bytes ||
    start + compressed > archive.length ||
    archive.subarray(30, 30 + nameLength).toString('utf8') !== pin.filename
  )
    throw new Error('Snapshot DAT entry identity mismatch');
  const payload = archive.subarray(start, start + compressed);
  const bytes =
    method === 0
      ? payload
      : method === 8
        ? inflateRawSync(payload, { maxOutputLength: pin.bytes })
        : null;
  if (
    !bytes ||
    bytes.length !== pin.bytes ||
    crc32(bytes) !== archive.readUInt32LE(14) ||
    digest(bytes) !== pin.sha256
  )
    throw new Error('Pinned snapshot DAT identity mismatch');
  return bytes;
}
function xmlText(value) {
  return value.replace(/&([^;]+);/g, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[entity] !== undefined) return named[entity];
    const numeric = /^#(?:x([a-f0-9]+)|([0-9]+))$/i.exec(entity);
    const point = numeric ? Number.parseInt(numeric[1] ?? numeric[2], numeric[1] ? 16 : 10) : NaN;
    if (
      !Number.isSafeInteger(point) ||
      point <= 0 ||
      point > 0x10ffff ||
      (point >= 0xd800 && point <= 0xdfff)
    )
      throw new Error('Unsupported XML entity');
    return String.fromCodePoint(point);
  });
}
function attributes(source) {
  const fields = {};
  const remainder = source.replace(/([a-z][a-z0-9_-]*)\s*=\s*"([^"]*)"/gi, (_, key, value) => {
    if (fields[key] !== undefined) throw new Error('Duplicate XML attribute');
    fields[key] = xmlText(value);
    return '';
  });
  if (remainder.trim()) throw new Error('Unsupported XML attributes');
  return fields;
}
function parseFirstTracks(bytes, expectedRecords) {
  const text = bytes.toString('utf8');
  // We never resolve the Logiqx DTD or external entities. Only literal attributes below are read.
  if (/<!ENTITY|<!\[CDATA\[/i.test(text)) throw new Error('Unsupported XML entity declaration');
  const records = [];
  for (const match of text.matchAll(/<game\b([^>]*)>([\s\S]*?)<\/game\s*>/g)) {
    const title = attributes(match[1]).name;
    const tracks = [...match[2].matchAll(/<rom\b([^>]*?)\s*\/>/g)]
      .map((rom) => attributes(rom[1]))
      .filter((rom) => / \(Track 0?1\)\.bin$/i.test(rom.name ?? ''));
    if (!title || title.length > 512 || tracks.length !== 1)
      throw new Error('Snapshot game must contain exactly one first track');
    const rom = tracks[0];
    const size = Number(rom.size);
    if (
      rom.name.length > 512 ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      !/^[a-f0-9]{8}$/i.test(rom.crc ?? '') ||
      !/^[a-f0-9]{32}$/i.test(rom.md5 ?? '') ||
      !/^[a-f0-9]{40}$/i.test(rom.sha1 ?? '')
    )
      throw new Error('Invalid first-track snapshot facts');
    records.push({
      title,
      name: rom.name,
      size,
      crc32: rom.crc.toLowerCase(),
      md5: rom.md5.toLowerCase(),
      sha1: rom.sha1.toLowerCase(),
    });
  }
  if (
    records.length !== expectedRecords ||
    new Set(records.map((row) => row.title)).size !== records.length
  )
    throw new Error('Snapshot record count or release-name uniqueness mismatch');
  return records;
}
export async function loadMetadataSnapshot(snapshot, { fetcher = fetch, snapshotRoot } = {}) {
  validatePin(snapshot.archive);
  validatePin(snapshot.dat);
  if (
    !Number.isSafeInteger(snapshot.dat.records) ||
    snapshot.dat.records < 1 ||
    snapshot.dat.records > 1000 ||
    new URL(snapshot.url).protocol !== 'https:'
  )
    throw new Error('Invalid metadata snapshot source');
  const archiveBytes = snapshotRoot
    ? await readFile(join(snapshotRoot, snapshot.archive.filename))
    : await fetchBounded(fetcher, snapshot.url, snapshot.archive.bytes);
  if (
    archiveBytes.length !== snapshot.archive.bytes ||
    digest(archiveBytes) !== snapshot.archive.sha256
  )
    throw new Error('Pinned metadata snapshot archive identity mismatch');
  const datBytes = extractDat(archiveBytes, snapshot.dat);
  const records = parseFirstTracks(datBytes, snapshot.dat.records);
  return {
    records,
    archiveBytes,
    receipt: {
      sourceId: snapshot.sourceId,
      url: snapshot.url,
      revision: snapshot.revision,
      archive: snapshot.archive,
      dat: snapshot.dat,
    },
  };
}
