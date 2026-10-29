import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cdiIdentificationPlugin } from '../src/cdi-identification.js';
import { automaticEvidence } from '../src/matching.js';
import { identifyRom } from '../src/rom-identification.js';

function fixture(
  version = 0x80000006,
  sectorSize = 2352,
  mode = 1,
  serial = 'T-12345N',
  extra = false,
) {
  const audio = Buffer.alloc(2352 * 2),
    sector = Buffer.alloc(sectorSize),
    header = Buffer.alloc(256, 32);
  header.write('SEGA SEGAKATANA ', 0, 'ascii');
  header.write(serial.padEnd(10), 0x40, 'ascii');
  header.write('Generated public-domain fixture', 0x80, 'ascii');
  const payload = sectorSize === 2048 ? 0 : sectorSize === 2336 ? 8 : mode === 1 ? 16 : 24;
  if (sectorSize >= 2352) {
    sector.fill(255, 1, 11);
    sector[15] = mode;
  }
  header.copy(sector, payload);
  function track(size: number, trackMode: number, pre = 0) {
    const chunks: Buffer[] = [];
    const u32 = (value: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(value);
      chunks.push(b);
    };
    const zero = (n: number) => chunks.push(Buffer.alloc(n));
    u32(extra ? 1 : 0);
    if (extra) zero(8);
    chunks.push(
      Buffer.from([0, 0, 1, 0, 0, 0, 255, 255, 255, 255]),
      Buffer.from([0, 0, 1, 0, 0, 0, 255, 255, 255, 255]),
    );
    zero(4);
    chunks.push(Buffer.from([0]));
    zero(19);
    u32(extra ? 0x80000000 : 0);
    if (extra) zero(8);
    zero(2);
    u32(pre);
    u32(trackMode === 0 ? 2 : 1);
    zero(6);
    u32(trackMode);
    zero(12);
    u32(trackMode === 0 ? 0 : 45000);
    u32(trackMode === 0 ? 2 : 1);
    zero(16);
    u32(({ 2048: 0, 2336: 1, 2352: 2, 2448: 4 } as Record<number, number>)[size] ?? 99);
    zero(29);
    if (version !== 0x80000004) {
      zero(5);
      u32(extra ? 0xffffffff : 0);
      if (extra) zero(78);
    }
    return Buffer.concat(chunks);
  }
  const session = Buffer.concat([
    Buffer.from([1, 0]),
    Buffer.from([1, 0]),
    track(2352, 0),
    Buffer.alloc(version === 0x80000004 ? 12 : 13),
    Buffer.from([1, 0]),
    track(sectorSize, mode),
    Buffer.alloc(version === 0x80000004 ? 12 : 13),
  ]);
  session.writeUInt16LE(2, 0);
  const data = Buffer.concat([audio, sector]);
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(version);
  footer.writeUInt32LE(version === 0x80000006 ? session.length + 8 : data.length, 4);
  return { bytes: Buffer.concat([data, session, footer]), headerStart: data.length };
}
async function identify(bytes: Buffer, systemId: string | null = 'com.provenance.dreamcast') {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-cdi-'));
  const path = join(dir, 'Generated.cdi');
  try {
    await writeFile(path, bytes);
    return await identifyRom({ path, name: 'Generated.cdi', systemId, size: bytes.length });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
for (const version of [0x80000004, 0x80000005, 0x80000006])
  test(`CDI ${version.toString(16)} resolves bounded data track IP.BIN after audio`, async () => {
    const result = await identify(fixture(version).bytes);
    assert.deepEqual(result.identifiers, [
      { type: 'serial', value: 'T-12345N', systemId: 'com.provenance.dreamcast', verified: true },
    ]);
    assert.deepEqual(result.hashes, []);
    assert.ok(result.pluginIds.includes('org.ecs.identify.cdi'));
  });
test('CDI handles supported sector payloads and descriptor extension fields', async () => {
  for (const [size, mode] of [
    [2048, 1],
    [2336, 2],
    [2352, 2],
    [2448, 1],
  ]) {
    const result = await identify(fixture(0x80000006, size, mode, 'T-12345N', true).bytes);
    assert.equal(result.identifiers[0]?.value, 'T-12345N');
  }
});
test('CDI descriptor corruption, truncation, bad modes and cross-system input cannot supply identity', async () => {
  const f = fixture();
  const bad: Buffer[] = [];
  const mutate = (at: number, value: number) => {
    const b = Buffer.from(f.bytes);
    b[at] = value;
    bad.push(b);
  };
  mutate(f.bytes.length - 8, 3);
  mutate(f.headerStart + 2, 255);
  mutate(f.headerStart + 8, 5);
  bad.push(f.bytes.subarray(0, -1));
  const wrongLength = Buffer.from(f.bytes);
  wrongLength.writeUInt32LE(0xffffffff, wrongLength.length - 4);
  bad.push(wrongLength);
  for (const bytes of bad) assert.equal((await identify(bytes)).identifiers.length, 0);
  assert.equal((await identify(f.bytes, 'com.provenance.jaguar')).identifiers.length, 0);
});

test('CDI requires byte-exact boot magic; high-bit masked ASCII cannot identify a disc', async () => {
  const f = fixture();
  for (let i = 0; i < 16; i++) f.bytes[2352 * 2 + 16 + i] = (f.bytes[2352 * 2 + 16 + i] ?? 0) ^ 128;
  assert.equal((await identify(f.bytes)).identifiers.length, 0);
});

test('CDI distinct verified IDs remain explicit conflicts rather than selecting a first track', async () => {
  const f = fixture();
  f.bytes.subarray(2352 * 2, 2352 * 3).copy(f.bytes, 0);
  f.bytes.write('T-67890N  ', 16 + 0x40, 'ascii');
  f.bytes.writeUInt32LE(1, f.headerStart + 72);
  const facts = await identify(f.bytes);
  assert.equal(facts.identifiers.length, 2);
  assert.equal(
    automaticEvidence(
      { name: 'Generated.cdi', systemId: 'com.provenance.dreamcast', companions: [], facts },
      {
        id: 'meta',
        title: 'Generated',
        kind: 'metadata',
        confidence: 'checksum',
        metadata: { systemId: 'com.provenance.dreamcast', serials: JSON.stringify(['T-12345N']) },
      },
    ),
    false,
  );
});
test('CDI cancellation after footer stops before descriptor and data-sector reads', async () => {
  const f = fixture(),
    abort = new AbortController();
  let reads = 0;
  await assert.rejects(
    cdiIdentificationPlugin.identify(
      {
        path: '/generated.cdi',
        name: 'Generated.cdi',
        size: f.bytes.length,
        systemId: 'com.provenance.dreamcast',
      },
      {
        read: async (offset, length) => {
          reads++;
          abort.abort(new Error('cancelled'));
          return f.bytes.subarray(offset, offset + length);
        },
        stream: async function* () {},
        runTool: async () => {
          throw new Error('Unexpected tool');
        },
      },
      abort.signal,
    ),
    /cancelled/,
  );
  assert.equal(reads, 1);
});
