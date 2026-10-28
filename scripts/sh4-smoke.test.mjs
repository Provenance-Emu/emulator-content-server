import assert from 'node:assert/strict';
import test from 'node:test';
import * as zlib from 'node:zlib';
import * as smoke from './browser-core/generate-sh4-smoke.mjs';

test('original Dreamcast ELF declares SH4 and a bounded executable RAM segment', () => {
  const elf = smoke.dreamcastSmokeElf();
  assert.deepEqual([...elf.subarray(0, 7)], [0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  assert.equal(elf.readUInt16LE(16), 2); // ET_EXEC
  assert.equal(elf.readUInt16LE(18), 42); // EM_SH
  assert.equal(elf.readUInt32LE(36), 9); // GNU EF_SH4, not an arbitrary architecture value.
  assert.equal(elf.readUInt16LE(42), 32);
  assert.equal(elf.readUInt16LE(44), 1);
  const ph = elf.readUInt32LE(28);
  assert.equal(elf.readUInt32LE(ph), 1); // PT_LOAD
  const offset = elf.readUInt32LE(ph + 4),
    address = elf.readUInt32LE(ph + 8);
  const size = elf.readUInt32LE(ph + 16);
  assert.equal(elf.readUInt32LE(24), address);
  assert.equal(address, 0x8c010000);
  assert.equal(elf.readUInt32LE(ph + 20), size);
  assert.equal(elf.readUInt32LE(ph + 24), 5); // Read + execute.
  assert.equal(offset % elf.readUInt32LE(ph + 28), address % elf.readUInt32LE(ph + 28));
  assert.equal(offset + size, elf.length);
  assert.deepEqual(elf.subarray(offset), smoke.sh4SmokeCode());
});

test('original SH4 code fills RGB565 green and keeps writing visible VRAM as its counter advances', () => {
  const code = smoke.sh4SmokeCode(),
    base = 0x8c010000;
  const registers = new Uint32Array(16),
    video = new Map(),
    counters = [];
  let pc = base,
    t = false,
    writes = 0,
    first,
    last;
  const read = (address) => {
    if (address === 0xa05f8044) return 0x00800000;
    assert.ok(
      address >= base && address + 4 <= base + code.length,
      `Unexpected read ${address.toString(16)}`,
    );
    return code.readUInt32LE(address - base);
  };
  const write = (address, value) => {
    if (address === 0x8c00f800) {
      counters.push({ value, writes });
      return;
    }
    if (address >= 0xa5000000 && address < 0xa5096000) {
      assert.equal(value, 0x07e007e0);
      first ??= address;
      last = address;
      writes++;
      return;
    }
    assert.ok(
      address >= 0xa05f8000 && address < 0xa05f8100,
      `Unexpected write ${address.toString(16)}`,
    );
    video.set(address, value);
  };
  for (let steps = 0; steps < 1_000_000 && counters.length < 3; steps++) {
    assert.ok(pc >= base && pc + 2 <= base + code.length, 'Instruction pointer escaped program');
    const instruction = pc,
      op = code.readUInt16LE(pc - base),
      n = (op >> 8) & 15,
      m = (op >> 4) & 15;
    pc += 2;
    if ((op & 0xf000) === 0xd000)
      registers[n] = read((((instruction + 4) & ~3) >>> 0) + (op & 255) * 4);
    else if ((op & 0xf000) === 0xe000) registers[n] = (op << 24) >> 24;
    else if ((op & 0xf00f) === 0x6002) registers[n] = read(registers[m]);
    else if ((op & 0xf00f) === 0x2002) write(registers[n], registers[m]);
    else if ((op & 0xf00f) === 0x2009) registers[n] &= registers[m];
    else if ((op & 0xf00f) === 0x200b) registers[n] |= registers[m];
    else if ((op & 0xf000) === 0x7000) registers[n] += (op << 24) >> 24;
    else if ((op & 0xf0ff) === 0x4010) t = --registers[n] === 0;
    else if ((op & 0xff00) === 0x8b00) {
      if (!t) pc = instruction + 4 + ((op << 24) >> 24) * 2;
    } else if ((op & 0xf000) === 0xa000) {
      assert.equal(code.readUInt16LE(pc - base), 0x0009, 'Branch delay slot must remain a nop');
      pc = instruction + 4 + ((op << 20) >> 20) * 2;
    } else assert.fail(`Unsupported SH4 smoke instruction ${op.toString(16)}`);
  }
  assert.equal(first, 0xa5000000);
  assert.equal(video.get(0xa05f8044), 0x00800005);
  assert.equal(video.get(0xa05f805c), 0x00177d3f);
  assert.equal(video.get(0xa05f8050), 0);
  assert.deepEqual(counters, [
    { value: 1, writes: 153601 },
    { value: 2, writes: 153602 },
    { value: 3, writes: 153603 },
  ]);
  assert.equal(last, 0xa5000000);
});

for (const naomi2 of [false, true]) {
  test(`original ${naomi2 ? 'Naomi2' : 'Naomi'} ZIP holds exactly one complete flat cartridge`, () => {
    assert.equal(typeof smoke.naomiSmokeZip, 'function');
    const zip = smoke.naomiSmokeZip(naomi2),
      end = zip.length - 22;
    assert.deepEqual(zip, smoke.naomiSmokeZip(naomi2), 'Fixture archive must be deterministic');
    assert.equal(zip.readUInt32LE(end), 0x06054b50);
    assert.equal(zip.readUInt16LE(end + 8), 1);
    assert.equal(zip.readUInt16LE(end + 10), 1);
    assert.equal(zip.readUInt16LE(end + 20), 0);
    const directory = zip.readUInt32LE(end + 16);
    assert.equal(directory + zip.readUInt32LE(end + 12), end);
    assert.equal(zip.readUInt32LE(directory), 0x02014b50);
    assert.equal(zip.readUInt32LE(directory + 42), 0);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.equal(zip.readUInt16LE(6), 0); // No encryption or data descriptor.
    assert.equal(zip.readUInt16LE(8), 0); // Stored, no decoder dependency.
    const size = zip.readUInt32LE(18),
      nameLength = zip.readUInt16LE(26),
      extra = zip.readUInt16LE(28);
    assert.equal(size, zip.readUInt32LE(22));
    assert.equal(size, zip.readUInt32LE(directory + 20));
    assert.equal(size, zip.readUInt32LE(directory + 24));
    assert.equal(zip.subarray(30, 30 + nameLength).toString(), 'original.bin');
    assert.equal(
      zip.subarray(directory + 46, directory + 46 + nameLength).toString(),
      'original.bin',
    );
    assert.equal(directory, 30 + nameLength + extra + size);
    const payload = zip.subarray(30 + nameLength + extra, directory);
    assert.deepEqual(payload, smoke.naomiSmokeCartridge(naomi2));
    assert.equal(payload.subarray(0, naomi2 ? 6 : 5).toString(), naomi2 ? 'Naomi2' : 'NAOMI');
    assert.equal(zip.readUInt32LE(14), zip.readUInt32LE(directory + 16));
    if (typeof zlib.crc32 === 'function') assert.equal(zip.readUInt32LE(14), zlib.crc32(payload));
    const piece = payload.readUInt32LE(0x360),
      address = payload.readUInt32LE(0x364),
      length = payload.readUInt32LE(0x368);
    assert.equal(address, 0x0c020000);
    assert.equal(payload.readUInt32LE(0x420), address);
    assert.equal(payload.readUInt32LE(0x424), address);
    assert.equal(payload.readUInt32LE(0x36c), 0xffffffff);
    assert.deepEqual(payload.subarray(piece, piece + length), smoke.sh4SmokeCode());
  });
}
