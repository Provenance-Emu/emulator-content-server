import assert from 'node:assert/strict';
import test from 'node:test';
import { psxSmokeCode, psxSmokeExe } from './browser-core/generate-psx-smoke.mjs';

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
