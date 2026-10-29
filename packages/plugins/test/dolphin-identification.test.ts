import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { openDolphinCiso, openPspCso } from '../src/dolphin-identification.js';
import { identifyRom, type ReaderContext } from '../src/rom-identification.js';

function reader(bytes: Buffer): ReaderContext {
  return {
    async read(offset, length) {
      assert.ok(length <= 1024 * 1024);
      assert.ok(offset >= 0 && offset + length <= bytes.length);
      return bytes.subarray(offset, offset + length);
    },
    async *stream() {
      yield* [];
      throw Error('Unexpected stream');
    },
    async runTool() {
      throw Error('No native converter allowed');
    },
  };
}
function header(system: 'gc' | 'wii', id = 'HBRE01'): Buffer {
  const value = Buffer.alloc(128);
  value.write(id, 0, 'ascii');
  value.writeUInt32BE(system === 'gc' ? 0xc2339f3d : 0x5d1c9ea3, system === 'gc' ? 0x1c : 0x18);
  return value;
}
function rvz(disc = header('gc'), wia = false): Buffer {
  const h1 = Buffer.alloc(0x48),
    h2 = Buffer.alloc(0xdc);
  h1.write(wia ? 'WIA' : 'RVZ');
  h1[3] = 1;
  h1.writeUInt32BE(0x01000000, 4);
  h1.writeUInt32BE(wia ? 0x01000000 : 0x00030000, 8);
  h1.writeUInt32BE(h2.length, 12);
  h1.writeBigUInt64BE(0x100000n, 36);
  h1.writeBigUInt64BE(BigInt(h1.length + h2.length), 44);
  h2.writeUInt32BE(disc.readUInt32BE(0x18) === 0x5d1c9ea3 ? 2 : 1, 0);
  h2.writeUInt32BE(wia ? 4 : 5, 4);
  if (wia) h2[212] = 1;
  h2.writeUInt32BE(2 * 1024 * 1024, 12);
  disc.copy(h2, 16);
  createHash('sha1').update(Buffer.alloc(0)).digest().copy(h2, 160);
  createHash('sha1').update(h2).digest().copy(h1, 16);
  createHash('sha1').update(h1.subarray(0, 52)).digest().copy(h1, 52);
  return Buffer.concat([h1, h2]);
}
function sparse(blockSize = 2048, map = [1], payload = header('gc')): Buffer {
  const h = Buffer.alloc(0x8000);
  h.write('CISO');
  h.writeUInt32LE(blockSize, 4);
  map.forEach((value, index) => {
    h[8 + index] = value;
  });
  const data = Buffer.alloc(map.filter((value) => value === 1).length * blockSize);
  payload.copy(data);
  return Buffer.concat([h, data]);
}
function isoRecord(lba: number, size: number, name: string, directory = false): Buffer {
  const encoded = Buffer.from(name, 'binary'),
    length = 33 + encoded.length + (encoded.length % 2 === 0 ? 1 : 0),
    record = Buffer.alloc(length);
  record[0] = length;
  record.writeUInt32LE(lba, 2);
  record.writeUInt32BE(lba, 6);
  record.writeUInt32LE(size, 10);
  record.writeUInt32BE(size, 14);
  record[25] = directory ? 2 : 0;
  record.writeUInt16LE(1, 28);
  record.writeUInt16BE(1, 30);
  record[32] = encoded.length;
  encoded.copy(record, 33);
  return record;
}
function pspIso(): Buffer {
  const bytes = Buffer.alloc(32 * 2048),
    pvd = bytes.subarray(16 * 2048, 17 * 2048);
  pvd[0] = 1;
  pvd.write('CD001', 1);
  pvd[6] = 1;
  pvd.writeUInt32LE(32, 80);
  pvd.writeUInt32BE(32, 84);
  pvd.writeUInt16LE(2048, 128);
  pvd.writeUInt16BE(2048, 130);
  isoRecord(20, 2048, '\0', true).copy(pvd, 156);
  isoRecord(21, 2048, 'PSP_GAME', true).copy(bytes, 20 * 2048);
  const sfo = Buffer.alloc(64);
  sfo.write('\0PSF', 0, 'binary');
  sfo.writeUInt32LE(0x101, 4);
  sfo.writeUInt32LE(36, 8);
  sfo.writeUInt32LE(44, 12);
  sfo.writeUInt32LE(1, 16);
  sfo.writeUInt16LE(0x204, 22);
  sfo.writeUInt32LE(10, 24);
  sfo.writeUInt32LE(12, 28);
  sfo.write('DISC_ID\0', 36, 'binary');
  sfo.write('ULUS12345\0', 44, 'binary');
  isoRecord(22, sfo.length, 'PARAM.SFO;1').copy(bytes, 21 * 2048);
  sfo.copy(bytes, 22 * 2048);
  return bytes;
}
function cso(
  bytes: Buffer,
  compressed: boolean,
  change?: (index: number, packet: Buffer) => Buffer,
  align = 0,
): Buffer {
  const frame = 2048,
    count = bytes.length / frame,
    header = Buffer.alloc(24),
    indexes = Buffer.alloc((count + 1) * 4),
    parts: Buffer[] = [];
  header.write('CISO');
  header.writeUInt32LE(24, 4);
  header.writeBigUInt64LE(BigInt(bytes.length), 8);
  header.writeUInt32LE(frame, 16);
  header[20] = 1;
  header[21] = align;
  const factor = 2 ** align,
    first = Math.ceil((24 + indexes.length) / factor) * factor;
  const lead = Buffer.alloc(first - 24 - indexes.length);
  let offset = first;
  for (let i = 0; i < count; i++) {
    const payload = bytes.subarray(i * frame, (i + 1) * frame),
      normal = compressed ? deflateRawSync(payload) : payload;
    const part = change ? change(i, normal) : normal;
    indexes.writeUInt32LE(((offset / factor) | (compressed ? 0 : 0x80000000)) >>> 0, i * 4);
    parts.push(part);
    offset += part.length;
    const padding = Math.ceil(offset / factor) * factor - offset;
    if (padding) {
      parts.push(Buffer.alloc(padding));
      offset += padding;
    }
  }
  indexes.writeUInt32LE(offset / factor, count * 4);
  return Buffer.concat([header, indexes, lead, ...parts]);
}
async function identify(bytes: Buffer, name: string) {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-dolphin-facts-'));
  const path = join(directory, name);
  await writeFile(path, bytes);
  try {
    return await identifyRom({ path, name, size: bytes.length, systemId: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
for (const wia of [false, true])
  for (const system of ['gc', 'wii'] as const)
    test(`${wia ? 'WIA' : 'RVZ'} canonical header establishes ${system} ID with no logical-image hash`, async () => {
      const facts = await identify(
        rvz(header(system), wia),
        wia ? 'generated.wia' : 'generated.rvz',
      );
      assert.deepEqual(facts.hashes, []);
      assert.equal(facts.identifiers[0]?.value, 'HBRE01');
      assert.equal(
        facts.identifiers[0]?.systemId,
        system === 'gc' ? 'com.provenance.gamecube' : 'com.provenance.wii',
      );
      assert.equal(facts.identifiers[0]?.verified, true);
    });
test('RVZ rejects hash, version, size, table range and cross-system contradictions', async () => {
  const variants: Buffer[] = [];
  let bytes = rvz();
  bytes[80] = (bytes[80] ?? 0) ^ 1;
  variants.push(bytes);
  bytes = rvz();
  bytes.writeUInt32BE(0x02000000, 8);
  variants.push(bytes);
  bytes = rvz();
  bytes.writeBigUInt64BE(99n, 44);
  createHash('sha1').update(bytes.subarray(0, 52)).digest().copy(bytes, 52);
  variants.push(bytes);
  bytes = rvz();
  bytes.writeUInt32BE(0x7fffffff, 12);
  createHash('sha1').update(bytes.subarray(0, 52)).digest().copy(bytes, 52);
  variants.push(bytes);
  bytes = rvz();
  bytes.writeBigUInt64BE(99999999n, 0x48 + 0xb8);
  bytes.writeUInt32BE(1, 0x48 + 0xb4);
  bytes.writeUInt32BE(1, 0x48 + 0xc0);
  createHash('sha1').update(bytes.subarray(0x48)).digest().copy(bytes, 16);
  createHash('sha1').update(bytes.subarray(0, 52)).digest().copy(bytes, 52);
  variants.push(bytes);
  bytes = rvz(header('wii'));
  bytes.writeUInt32BE(1, 0x48);
  createHash('sha1').update(bytes.subarray(0x48)).digest().copy(bytes, 16);
  createHash('sha1').update(bytes.subarray(0, 52)).digest().copy(bytes, 52);
  variants.push(bytes);
  variants.push(rvz().subarray(0, 100));
  for (const variant of variants) {
    const facts = await identify(variant, 'generated.rvz');
    assert.deepEqual(facts.identifiers, []);
    assert.deepEqual(facts.hashes, []);
    assert.ok(facts.warnings.length);
  }
});
test('Dolphin CISO maps stored and zero sparse blocks without confusing PSP CSO', async () => {
  const bytes = sparse(2048, [1, 0, 1]);
  const logical = await openDolphinCiso(
    { path: '/generated', name: 'generated.ciso', size: bytes.length, systemId: null },
    reader(bytes),
  );
  assert.ok(logical);
  assert.deepEqual(Buffer.from(await logical.read(2048, 32)), Buffer.alloc(32));
  const crossing = Buffer.from(await logical.read(2040, 16));
  assert.deepEqual(crossing, Buffer.alloc(16));
  assert.equal(
    await openPspCso(
      { path: '/generated', name: 'generated.ciso', size: bytes.length, systemId: null },
      reader(bytes),
    ),
    null,
  );
  const facts = await identify(bytes, 'generated.ciso');
  assert.equal(facts.identifiers[0]?.systemId, 'com.provenance.gamecube');
  assert.deepEqual(facts.hashes, []);
});
for (const compressed of [false, true])
  test(`PSP CSO ${compressed ? 'DEFLATE' : 'plain'} windows identify PARAM.SFO DISC_ID`, async () => {
    const bytes = cso(pspIso(), compressed),
      facts = await identify(bytes, 'generated.cso');
    assert.deepEqual(facts.hashes, []);
    assert.deepEqual(facts.identifiers, [
      { type: 'serial', value: 'ULUS-12345', systemId: 'com.provenance.psp', verified: true },
    ]);
  });
test('CISO malformed block maps, CSO indexes, versions, truncation and DEFLATE expansion stay unverified', async () => {
  const variants: Buffer[] = [];
  let bytes = sparse();
  bytes[8] = 2;
  variants.push(bytes);
  variants.push(sparse().subarray(0, 0x8010));
  bytes = cso(pspIso(), true);
  bytes[20] = 2;
  variants.push(bytes);
  bytes = cso(pspIso(), true);
  bytes.writeUInt32LE(0xffffffff, 24 + 16 * 4);
  variants.push(bytes);
  bytes = cso(pspIso(), true);
  bytes.writeUInt32LE(0xffffffff, 16);
  variants.push(bytes);
  variants.push(cso(pspIso(), true).subarray(0, 40));
  for (const variant of variants) {
    const facts = await identify(variant, 'generated.ciso');
    assert.deepEqual(facts.identifiers, []);
    assert.deepEqual(facts.hashes, []);
    assert.ok(facts.warnings.length);
  }
});

test('CSO alignment padding is bounded; extra DEFLATE streams, junk and over-expansion cannot provide PSP identity', async () => {
  const good = await identify(cso(pspIso(), true, undefined, 4), 'aligned.cso');
  assert.equal(good.identifiers[0]?.value, 'ULUS-12345');
  for (const change of [
    (index: number, packet: Buffer) =>
      index === 16 ? Buffer.concat([packet, Buffer.from([1])]) : packet,
    (index: number, packet: Buffer) =>
      index === 16 ? Buffer.concat([packet, deflateRawSync(Buffer.alloc(0))]) : packet,
    (index: number, packet: Buffer) =>
      index === 16 ? deflateRawSync(Buffer.alloc(65536)) : packet,
  ]) {
    const facts = await identify(cso(pspIso(), true, change), 'malicious.cso');
    assert.deepEqual(facts.identifiers, []);
    assert.ok(facts.warnings.length);
  }
});

test('PSP directory and SFO extents cannot escape their declared ISO volume or claim ambiguous IDs', async () => {
  const variants: Buffer[] = [];
  let iso = pspIso();
  iso.writeUInt32LE(20, 16 * 2048 + 80);
  iso.writeUInt32BE(20, 16 * 2048 + 84);
  variants.push(iso);
  iso = pspIso();
  iso.writeUInt32LE(31, 20 * 2048 + 2);
  iso.writeUInt32BE(31, 20 * 2048 + 6);
  iso.writeUInt32LE(4096, 20 * 2048 + 10);
  iso.writeUInt32BE(4096, 20 * 2048 + 14);
  variants.push(iso);
  iso = pspIso();
  iso.writeUInt32LE(0xffffffff, 22 * 2048 + 12);
  variants.push(iso);
  iso = pspIso();
  iso.writeUInt32LE(0xffffffff, 22 * 2048 + 28);
  variants.push(iso);
  iso = pspIso();
  iso[21 * 2048 + 25] = 0x80;
  variants.push(iso);
  for (const bytes of variants) {
    const facts = await identify(cso(bytes, true), 'bounds.cso');
    assert.deepEqual(facts.identifiers, []);
    assert.ok(facts.warnings.length);
  }
});

test('bounded logical reads preserve cancellation and reject requested windows beyond their byte range', async () => {
  const bytes = sparse(),
    abort = new AbortController(),
    logical = await openDolphinCiso(
      { path: '/generated', name: 'generated.ciso', size: bytes.length, systemId: null },
      reader(bytes),
      abort.signal,
    );
  assert.ok(logical);
  await assert.rejects(logical.read(logical.size, 1));
  await assert.rejects(logical.read(0, 65537));
  abort.abort();
  await assert.rejects(logical.read(0, 32), { name: 'AbortError' });
  const csoBytes = cso(pspIso(), true);
  await assert.rejects(
    openPspCso(
      { path: '/generated', name: 'generated.cso', size: csoBytes.length, systemId: null },
      reader(csoBytes),
      abort.signal,
    ),
    { name: 'AbortError' },
  );
});

test('sparse CISO zero banks and stored-bank numbering preserve actual GC/Wii magic', async () => {
  const bytes = sparse(2048, [1, 0, 1]);
  bytes.fill(0x42, 0x8000 + 2048);
  const logical = await openDolphinCiso(
    { path: '/generated', name: 'banks.ciso', size: bytes.length, systemId: null },
    reader(bytes),
  );
  assert.ok(logical);
  assert.deepEqual(Buffer.from(await logical.read(2 * 2048, 16)), Buffer.alloc(16, 0x42));
  const zero = sparse(2048, []),
    empty = await openDolphinCiso(
      { path: '/generated', name: 'zero.ciso', size: zero.length, systemId: null },
      reader(zero),
    );
  assert.ok(empty);
  assert.deepEqual(Buffer.from(await empty.read(0, 128)), Buffer.alloc(128));
  assert.deepEqual((await identify(zero, 'zero.ciso')).identifiers, []);
  assert.equal(
    (await identify(sparse(2048, [1], header('wii')), 'wii.ciso')).identifiers[0]?.systemId,
    'com.provenance.wii',
  );
  const both = header('gc');
  both.writeUInt32BE(0x5d1c9ea3, 0x18);
  assert.deepEqual((await identify(sparse(2048, [1], both), 'conflict.ciso')).identifiers, []);
});

test('duplicate PARAM.SFO DISC_ID keys and duplicate PSP directory names are explicit ambiguity', async () => {
  const duplicates = pspIso(),
    sfo = Buffer.alloc(128);
  sfo.write('\0PSF', 0, 'binary');
  sfo.writeUInt32LE(0x101, 4);
  sfo.writeUInt32LE(52, 8);
  sfo.writeUInt32LE(64, 12);
  sfo.writeUInt32LE(2, 16);
  for (const at of [20, 36]) {
    sfo.writeUInt16LE(0x204, at + 2);
    sfo.writeUInt32LE(10, at + 4);
    sfo.writeUInt32LE(12, at + 8);
  }
  sfo.writeUInt32LE(12, 48);
  sfo.write('DISC_ID\0', 52, 'binary');
  sfo.write('ULUS12345\0', 64, 'binary');
  sfo.write('ULUS54321\0', 76, 'binary');
  sfo.copy(duplicates, 22 * 2048);
  duplicates.writeUInt32LE(sfo.length, 21 * 2048 + 10);
  duplicates.writeUInt32BE(sfo.length, 21 * 2048 + 14);
  assert.deepEqual((await identify(cso(duplicates, true), 'duplicate.cso')).identifiers, []);
  const directory = pspIso();
  const duplicate = isoRecord(21, 2048, 'PSP_GAME', true);
  duplicate.copy(directory, 20 * 2048 + duplicate.length);
  assert.deepEqual((await identify(cso(directory, true), 'directory.cso')).identifiers, []);
});
