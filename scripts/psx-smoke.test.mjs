import assert from 'node:assert/strict';
import test from 'node:test';
import * as psx from './browser-core/generate-psx-smoke.mjs';
import { psxSmokeCode, psxSmokeExe } from './browser-core/generate-psx-smoke.mjs';

test('generated raw CD sectors retain Mode 2 user data at byte 24 for CHD boot probes', () => {
  const iso = psx.psxSmokeIso();
  const track = psx.psxSmokeMode2Track();
  assert.equal(track.length, (iso.length / 2048) * 2352);
  for (let lba = 0; lba < iso.length / 2048; lba++) {
    const sector = track.subarray(lba * 2352, (lba + 1) * 2352);
    assert.deepEqual(sector.subarray(0, 12), Buffer.from([0, ...Array(10).fill(255), 0]));
    assert.equal(sector[15], 2);
    assert.deepEqual(sector.subarray(16, 20), sector.subarray(20, 24));
    assert.equal(sector[18], 8);
    assert.deepEqual(sector.subarray(24, 24 + 2048), iso.subarray(lba * 2048, (lba + 1) * 2048));
  }
});

test('original PSX disc boots the same generated executable through its ISO9660 directory', () => {
  const disc = psx.psxSmokeIso();
  const pvd = disc.subarray(16 * 2048, 17 * 2048);
  assert.equal(pvd.subarray(1, 6).toString(), 'CD001');
  assert.equal(pvd.readUInt32LE(80) * 2048, disc.length);
  assert.equal(pvd.readUInt16LE(128), 2048);
  const rootLba = pvd.readUInt32LE(158);
  const rootSize = pvd.readUInt32LE(166);
  const rows = new Map();
  for (
    let offset = rootLba * 2048;
    offset < rootLba * 2048 + rootSize && disc[offset];
    offset += disc[offset]
  ) {
    const width = disc[offset];
    assert.ok(width >= 34 && offset + width <= disc.length);
    const name = disc.subarray(offset + 33, offset + 33 + disc[offset + 32]).toString();
    const lba = disc.readUInt32LE(offset + 2);
    const size = disc.readUInt32LE(offset + 10);
    assert.equal(lba, disc.readUInt32BE(offset + 6));
    assert.equal(size, disc.readUInt32BE(offset + 14));
    assert.ok(lba * 2048 + size <= disc.length);
    rows.set(name, disc.subarray(lba * 2048, lba * 2048 + size));
  }
  assert.match(rows.get('SYSTEM.CNF;1').toString(), /BOOT = cdrom:\\ECS_TEST\.EXE;1/);
  assert.deepEqual(rows.get('ECS_TEST.EXE;1'), psxSmokeExe());
});

test('original PS-X EXE has a sector-aligned RAM segment, entry and stack', () => {
  const exe = psxSmokeExe();
  assert.equal(exe.subarray(0, 8).toString(), 'PS-X EXE');
  assert.equal(exe.readUInt32LE(0x10), 0x80010000);
  assert.equal(exe.readUInt32LE(0x18), 0x80010000);
  assert.equal(exe.readUInt32LE(0x30), 0x801fff00);
  assert.equal(exe.readUInt32LE(0x1c), exe.length - 0x800);
  assert.equal(exe.length % 0x800, 0);
  assert.deepEqual(exe.subarray(0x800, 0x800 + psxSmokeCode().length), psxSmokeCode());
});

test('original MIPS payload enables RGB15 display, fills green and advances a RAM counter', () => {
  const code = psxSmokeCode(),
    base = 0x80010000,
    registers = new Uint32Array(32);
  const gpu = [],
    display = [],
    counters = [];
  let pc = base;
  for (let steps = 0; steps < 200 && counters.length < 3; steps++) {
    assert.ok(pc >= base && pc + 4 <= base + code.length);
    const op = code.readUInt32LE(pc - base),
      instruction = pc;
    const type = op >>> 26,
      rs = (op >>> 21) & 31,
      rt = (op >>> 16) & 31,
      immediate = op & 0xffff;
    pc += 4;
    if (type === 15) registers[rt] = immediate << 16;
    else if (type === 13) registers[rt] = registers[rs] | immediate;
    else if (type === 9) registers[rt] = registers[rs] + ((immediate << 16) >> 16);
    else if (type === 43) {
      const address = registers[rs] + ((immediate << 16) >> 16),
        value = registers[rt];
      if (address === 0x1f801810) gpu.push(value);
      else if (address === 0x1f801814) display.push(value);
      else {
        assert.equal(address, 0x80020000);
        counters.push(value);
      }
    } else if (type === 4) {
      assert.equal(registers[rs], registers[rt]);
      assert.equal(code.readUInt32LE(pc - base), 0, 'Delay slot must remain a nop');
      pc = instruction + 4 + ((immediate << 16) >> 16) * 4;
    } else assert.fail(`Unsupported smoke opcode ${op.toString(16)}`);
    assert.equal(registers[0], 0);
  }
  assert.deepEqual(display, [0, 0x03000000, 0x05000000, 0x06c60260, 0x07042018, 0x08000001]);
  assert.deepEqual(gpu.slice(0, 3), [0x0200ff00, 0, 0x00f00140]);
  assert.deepEqual(
    gpu.slice(3),
    [0x0200ff00, 0, 0x00010010, 0x0200ff00, 0, 0x00010010, 0x0200ff00, 0, 0x00010010],
  );
  assert.deepEqual(counters, [1, 2, 3]);
});
