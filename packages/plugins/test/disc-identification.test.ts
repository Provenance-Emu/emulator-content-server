import assert from 'node:assert/strict';
import test from 'node:test';
import { discIdentificationPlugins } from '../src/disc-identification.js';
import { validateRomFacts } from '../src/rom-facts.js';
import type { IdentificationRequest, ReaderContext } from '../src/rom-identification.js';

const PSX = 'com.provenance.psx',
  PS2 = 'com.provenance.ps2',
  DC = 'com.provenance.dreamcast';
function twin32(bytes: Buffer, offset: number, value: number) {
  bytes.writeUInt32LE(value, offset);
  bytes.writeUInt32BE(value, offset + 4);
}
function twin16(bytes: Buffer, offset: number, value: number) {
  bytes.writeUInt16LE(value, offset);
  bytes.writeUInt16BE(value, offset + 2);
}
function record(lba: number, size: number, name: string | number, directory = false) {
  const label = typeof name === 'number' ? Buffer.from([name]) : Buffer.from(name);
  const bytes = Buffer.alloc(33 + label.length + (label.length % 2 === 0 ? 1 : 0));
  bytes[0] = bytes.length;
  twin32(bytes, 2, lba);
  twin32(bytes, 10, size);
  bytes[25] = directory ? 2 : 0;
  twin16(bytes, 28, 1);
  bytes[32] = label.length;
  label.copy(bytes, 33);
  return bytes;
}
function iso(config = 'BOOT = cdrom:\\SLUS_123.45;1\r\n') {
  const bytes = Buffer.alloc(32 * 2048);
  const pvd = bytes.subarray(16 * 2048, 17 * 2048);
  pvd.set([1, ...Buffer.from('CD001'), 1]);
  twin32(pvd, 80, 32);
  twin16(pvd, 120, 1);
  twin16(pvd, 124, 1);
  twin16(pvd, 128, 2048);
  record(20, 2048, 0, true).copy(pvd, 156);
  const entries = [
    record(20, 2048, 0, true),
    record(20, 2048, 1, true),
    record(21, Buffer.byteLength(config), 'SYSTEM.CNF;1'),
  ];
  Buffer.concat(entries).copy(bytes, 20 * 2048);
  bytes.write(config, 21 * 2048, 'ascii');
  return bytes;
}
function ip(serial = 'T-12345N') {
  const bytes = Buffer.alloc(2048, 32);
  bytes.write('SEGA SEGAKATANA ', 0, 'ascii');
  bytes.write(serial.padEnd(10), 0x40, 'ascii');
  bytes.write('Generated disc fixture'.padEnd(128), 0x80, 'ascii');
  return bytes;
}
function raw(bytes: Buffer, mode: 1 | 2, size = 2352) {
  const result: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += 2048) {
    const sector = Buffer.alloc(size);
    if (size === 2352) {
      sector.fill(255, 1, 11);
      sector[15] = mode;
    }
    bytes.subarray(at, at + 2048).copy(sector, size === 2336 ? 8 : mode === 1 ? 16 : 24);
    result.push(sector);
  }
  return Buffer.concat(result);
}
function harness(
  text: string,
  members: Record<string, Buffer>,
  extension = 'cue',
  systemId: string | null = PSX,
) {
  const descriptor = Buffer.from(text);
  const request: IdentificationRequest = {
    name: `Generated.${extension}`,
    path: `/host/Generated.${extension}`,
    size: descriptor.length,
    systemId,
    media: {
      entry: `disc/Generated.${extension}`,
      members: Object.entries(members).map(([name, bytes]) => ({
        name,
        path: `/host/${name}`,
        size: bytes.length,
      })),
    },
  };
  const calls: { name: string; offset: number; length: number }[] = [];
  const reader: ReaderContext = {
    read: async (offset, length) => descriptor.subarray(offset, offset + length),
    readMember: async (name, offset, length) => {
      calls.push({ name, offset, length });
      const bytes = members[name];
      assert.ok(bytes, `No allowlisted member ${name}`);
      return bytes.subarray(offset, offset + length);
    },
    stream() {
      throw new Error('No whole-disc stream');
    },
    runTool: async () => {
      throw new Error('No tools');
    },
  };
  const plugin = discIdentificationPlugins.find((candidate) => candidate.supports(request));
  assert.ok(plugin);
  return {
    request,
    reader,
    calls,
    identify: async (signal?: AbortSignal) =>
      validateRomFacts(await plugin.identify(request, reader, signal)),
  };
}
const simple = (mode = 'MODE1/2048', name = 'data.bin') =>
  `FILE "${name}" BINARY\n TRACK 01 ${mode}\n INDEX 01 00:00:00\n`;
test('CUE reads bounded PSX SYSTEM.CNF extents without whole-disc hashes or filename guesses', async () => {
  const f = harness(simple(), { 'disc/data.bin': iso() });
  const facts = await f.identify();
  assert.deepEqual(facts.identifiers, [
    { type: 'serial', value: 'SLUS-12345', systemId: PSX, verified: true },
  ]);
  assert.deepEqual(facts.hashes, []);
  assert.ok(f.calls.every((call) => call.length <= 2352));
  assert.ok(f.calls.reduce((sum, call) => sum + call.length, 0) < 16384);
});
test('CUE BOOT2 identifies PS2 and repeated identical IDs deduplicate', async () => {
  const f = harness(
    simple(),
    { 'disc/data.bin': iso('BOOT2 = cdrom0:\\SLES_543.21;1\nBOOT2 = cdrom0:\\SLES_543.21;1\n') },
    'cue',
    PS2,
  );
  assert.deepEqual((await f.identify()).identifiers, [
    { type: 'serial', value: 'SLES-54321', systemId: PS2, verified: true },
  ]);
});
for (const [mode, sector, sectorMode] of [
  ['MODE1/2352', 2352, 1],
  ['MODE2/2352', 2352, 2],
  ['MODE2/2336', 2336, 2],
] as const) {
  test(`CUE ${mode} validates sector headers and maps user-data extents`, async () => {
    const f = harness(simple(mode), { 'disc/data.bin': raw(iso(), sectorMode, sector) });
    assert.equal((await f.identify()).identifiers[0]?.value, 'SLUS-12345');
  });
}
test('CUE INDEX01 skips stored pregap and PREGAP never adds phantom bytes to shared BIN', async () => {
  const bytes = Buffer.concat([Buffer.alloc(150 * 2352), raw(iso(), 1), Buffer.alloc(2 * 2352)]);
  const text =
    'FILE "shared.bin" BINARY\nTRACK 01 MODE1/2352\nINDEX 00 00:00:00\nINDEX 01 00:02:00\nTRACK 02 AUDIO\nPREGAP 00:02:00\nINDEX 01 00:02:32\n';
  const f = harness(text, { 'disc/shared.bin': bytes });
  assert.equal((await f.identify()).identifiers[0]?.value, 'SLUS-12345');
  assert.ok(f.calls.every((call) => call.offset >= 150 * 2352 && call.offset < 182 * 2352));
});
test('secondary CUE data tracks do not invent ISO logical-address rebasing', async () => {
  const f = harness(
    'FILE "audio.bin" BINARY\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nFILE "data.bin" BINARY\nTRACK 02 MODE1/2048\nINDEX 01 00:00:00\n',
    { 'disc/audio.bin': Buffer.alloc(2352), 'disc/data.bin': iso() },
  );
  const facts = await f.identify();
  assert.equal(facts.identifiers.length, 0);
  assert.ok(facts.warnings.some((warning) => warning.includes('secondary-track')));
});
test('GDI quoted names, byte offsets and high-density track3 find exact Dreamcast IP.BIN', async () => {
  const f = harness(
    '3\n1 0 4 2048 low.bin 0\n2 450 0 2352 audio.bin 0\n3 45000 4 2352 "High Density.bin" 7\n',
    {
      'disc/low.bin': Buffer.alloc(2048),
      'disc/audio.bin': Buffer.alloc(2352),
      'disc/High Density.bin': Buffer.concat([Buffer.alloc(7), raw(ip(), 1)]),
    },
    'gdi',
    DC,
  );
  const facts = await f.identify();
  assert.equal(facts.identifiers[0]?.value, 'T-12345N');
  assert.deepEqual(facts.names, ['Generated disc fixture']);
  assert.equal(f.calls.at(-1)?.offset, 7);
  assert.equal(f.calls.length, 2);
});
test('unique case fallback stays in the member allowlist and contained parent refs resolve', async () => {
  const f = harness(simple('MODE1/2048', '../tracks/DATA.BIN'), { 'tracks/data.bin': iso() });
  assert.equal((await f.identify()).identifiers.length, 1);
  assert.ok(f.calls.every((call) => call.name === 'tracks/data.bin'));
});
test('disc names, approved Jaguar headers, padding and masked magic cannot supply a serial', async () => {
  const jaguar = Buffer.alloc(2352);
  jaguar.write('ATARI APPROVED DATA HEADER ATRI ', 0x42, 'ascii');
  const f = harness(
    simple('AUDIO', 'SLUS_123.45.bin'),
    { 'disc/SLUS_123.45.bin': jaguar },
    'cue',
    'com.provenance.jaguarcd',
  );
  const facts = await f.identify();
  assert.deepEqual(facts.identifiers, []);
  assert.deepEqual(facts.hashes, []);
  assert.ok(facts.warnings.some((warning) => warning.includes('jaguarcd')));
  assert.equal(f.calls.length, 0);
  const bytes = ip();
  for (let n = 0; n < 16; n++) bytes[n] = (bytes[n] ?? 0) | 128;
  assert.equal(
    (
      await harness(
        '1\n1 45000 4 2048 data.bin 0',
        { 'disc/data.bin': bytes },
        'gdi',
        DC,
      ).identify()
    ).identifiers.length,
    0,
  );
  assert.equal(
    (
      await harness(
        '1\n1 45000 4 2048 data.bin 0',
        { 'disc/data.bin': Buffer.concat([Buffer.alloc(2048), ip()]) },
        'gdi',
        DC,
      ).identify()
    ).identifiers.length,
    0,
  );
});
test('conflicting boot serials and differing GDI data-track serials remain explicit', async () => {
  const cue = await harness(simple(), {
    'disc/data.bin': iso('BOOT = cdrom:\\SLUS_123.45;1\nBOOT = cdrom:\\SLUS_678.90;1\n'),
  }).identify();
  assert.deepEqual(
    cue.identifiers.map((id) => id.value),
    ['SLUS-12345', 'SLUS-67890'],
  );
  const gdi = await harness(
    '2\n1 0 4 2048 one.bin 0\n2 45000 4 2048 two.bin 0',
    { 'disc/one.bin': ip(), 'disc/two.bin': ip('T-67890N') },
    'gdi',
    DC,
  ).identify();
  assert.equal(gdi.identifiers.length, 2);
  assert.ok(gdi.warnings.some((warning) => warning.includes('conflict')));
});
test('system disagreement retains contradictory actual identifiers without relabeling them', async () => {
  const cue = await harness(simple(), { 'disc/data.bin': iso() }, 'cue', PS2).identify();
  assert.deepEqual(cue.identifiers, [
    { type: 'serial', value: 'SLUS-12345', systemId: PSX, verified: true },
  ]);
  assert.ok(cue.warnings.includes('disc-system-conflict'));
  const gdi = await harness(
    '1\n1 45000 4 2048 data.bin 0',
    { 'disc/data.bin': ip() },
    'gdi',
    PSX,
  ).identify();
  assert.deepEqual(gdi.identifiers, [
    { type: 'serial', value: 'T-12345N', systemId: DC, verified: true },
  ]);
  assert.ok(gdi.warnings.includes('disc-system-conflict'));
});
for (const name of [
  '/data.bin',
  '../../data.bin',
  'https://example.com/data.bin',
  'C:\\data.bin',
]) {
  test(`unsafe descriptor reference ${name} is rejected before member reads`, async () => {
    const f = harness(simple('MODE1/2048', name), { 'disc/data.bin': iso() });
    assert.equal((await f.identify()).identifiers.length, 0);
    assert.equal(f.calls.length, 0);
  });
}
test('missing, ambiguous and malformed layouts fail closed before member reads', async () => {
  for (const text of [
    simple('MODE1/2048', 'missing.bin'),
    simple().replace('BINARY', 'WAVE'),
    simple().replace('INDEX 01', 'INDEX 00'),
    `${simple()}TRACK 01 AUDIO\nINDEX 01 00:00:00`,
    simple().replace('00:00:00', '00:99:00'),
  ]) {
    const f = harness(text, { 'disc/data.bin': iso() });
    assert.equal((await f.identify()).identifiers.length, 0);
    assert.equal(f.calls.length, 0);
  }
  const f = harness(simple(), { 'disc/data.bin': iso(), 'disc/DATA.BIN': iso() });
  assert.equal((await f.identify()).identifiers.length, 0);
  assert.equal(f.calls.length, 0);
});
test('bad raw sync/mode, duplicate config entries, endian twins and extents never identify', async () => {
  const variants = [iso(), iso(), iso(), iso(), iso()];
  variants[0]?.writeUInt32BE(999, 16 * 2048 + 84);
  variants[1]?.writeUInt32LE(0xffffffff, 16 * 2048 + 158);
  variants[2]?.set(
    record(21, 25, 'SYSTEM.CNF;1'),
    20 * 2048 + 34 * 2 + record(21, 25, 'SYSTEM.CNF;1').length,
  );
  variants[3]?.writeUInt32LE(0xffffff, 20 * 2048 + 34 * 2 + 2);
  if (variants[4]) variants[4][21 * 2048] = 0xc2;
  for (const bytes of variants)
    assert.equal(
      (await harness(simple(), { 'disc/data.bin': bytes }).identify()).identifiers.length,
      0,
    );
  const sector = raw(iso(), 2);
  sector[16 * 2352 + 1] = 0;
  assert.equal(
    (await harness(simple('MODE2/2352'), { 'disc/data.bin': sector }).identify()).identifiers
      .length,
    0,
  );
  const truncated = harness(simple(), { 'disc/data.bin': iso().subarray(0, -1) });
  assert.equal((await truncated.identify()).identifiers.length, 0);
});
test('unsupported or absent member capability and descriptor/track/member bounds fail closed', async () => {
  for (const count of [100, 129]) {
    const f = harness(
      `${count}\n${Array.from({ length: count }, (_, n) => `${n + 1} ${n * 45000} 4 2048 ${n}.bin 0`).join('\n')}`,
      Object.fromEntries(Array.from({ length: count }, (_, n) => [`disc/${n}.bin`, ip()])),
      'gdi',
      DC,
    );
    assert.equal((await f.identify()).identifiers.length, 0);
    assert.equal(f.calls.length, 0);
  }
  const f = harness(`REM ${'x'.repeat(65536)}\n${simple()}`, { 'disc/data.bin': iso() });
  assert.equal((await f.identify()).identifiers.length, 0);
  assert.equal(f.calls.length, 0);
  const noMembers = harness(simple(), { 'disc/data.bin': iso() });
  delete noMembers.reader.readMember;
  assert.equal((await noMembers.identify()).identifiers.length, 0);
  const noMedia = harness(simple(), { 'disc/data.bin': iso() });
  delete noMedia.request.media;
  assert.equal((await noMedia.identify()).identifiers.length, 0);
  const nine = harness(
    `9\n${Array.from({ length: 9 }, (_, n) => `${n + 1} ${n * 45000} 4 2048 ${n}.bin 0`).join('\n')}`,
    Object.fromEntries(Array.from({ length: 9 }, (_, n) => [`disc/${n}.bin`, ip()])),
    'gdi',
    DC,
  );
  assert.equal((await nine.identify()).identifiers.length, 0);
  assert.equal(nine.calls.length, 0);
});
test('cancellation is checked after descriptor and before every member read', async () => {
  const f = harness(simple(), { 'disc/data.bin': iso() });
  const abort = new AbortController();
  const read = f.reader.read;
  f.reader.read = async (offset, length) => {
    const bytes = await read(offset, length);
    abort.abort(new Error('cancelled'));
    return bytes;
  };
  await assert.rejects(f.identify(abort.signal), /cancelled/);
  assert.equal(f.calls.length, 0);
});
test('an unsupported additional BOOT directive cannot be hidden beside a valid serial', async () => {
  const bytes = iso('BOOT = cdrom:\\SLUS_123.45;1\nBOOT = cdrom:\\nested\\SLES_543.21;1\n');
  assert.equal(
    (await harness(simple(), { 'disc/data.bin': bytes }).identify()).identifiers.length,
    0,
  );
});
test('ISO root/config byte limits, volume bounds and raw XA forms are enforced', async () => {
  const badRoot = iso();
  twin32(badRoot, 16 * 2048 + 156 + 10, 65537);
  const badConfig = iso();
  twin32(badConfig, 20 * 2048 + 68 + 10, 8193);
  const outside = iso();
  twin32(outside, 20 * 2048 + 68 + 2, 32);
  for (const bytes of [badRoot, badConfig, outside])
    assert.equal(
      (await harness(simple(), { 'disc/data.bin': bytes }).identify()).identifiers.length,
      0,
    );
  for (const offset of [16, 18]) {
    const bytes = raw(iso(), 2);
    bytes[16 * 2352 + offset] = offset === 18 ? 0x20 : 1;
    if (offset === 18) bytes[16 * 2352 + 22] = 0x20;
    assert.equal(
      (await harness(simple('MODE2/2352'), { 'disc/data.bin': bytes }).identify()).identifiers
        .length,
      0,
    );
  }
});
test('short member reads, GDI malformed tables and overlapping tracks cannot return evidence', async () => {
  for (const text of [
    '2\n1 45000 4 2048 data.bin 0',
    '1\n1 45000 4 2048 data.bin -1',
    '1\n2 45000 4 2048 data.bin 0',
    '2\n1 0 4 2048 data.bin 0\n2 0 4 2048 data.bin 0',
  ]) {
    const f = harness(text, { 'disc/data.bin': ip() }, 'gdi', DC);
    assert.equal((await f.identify()).identifiers.length, 0);
    assert.equal(f.calls.length, 0);
  }
  const f = harness(simple(), { 'disc/data.bin': iso() });
  f.reader.readMember = async () => Buffer.alloc(100);
  assert.equal((await f.identify()).identifiers.length, 0);
});
test('cancellation during a member read rejects without reading PVD/root/config', async () => {
  const f = harness(simple(), { 'disc/data.bin': iso() });
  const abort = new AbortController();
  const read = f.reader.readMember;
  f.reader.readMember = async (name, offset, length) => {
    const bytes = await read?.(name, offset, length);
    abort.abort(new Error('member-cancelled'));
    return bytes ?? new Uint8Array();
  };
  await assert.rejects(f.identify(abort.signal), /member-cancelled/);
  assert.equal(f.calls.length, 1);
});
