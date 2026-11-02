/** Original MIPS program in the IPL3 region; uses the core's existing PIF boot HLE. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function originalN64Program() {
  const words = [],
    labels = new Map(),
    branches = [];
  const emit = (word) => words.push(word >>> 0);
  const immediate = (op, rt, rs, value) =>
    emit((op << 26) | (rs << 21) | (rt << 16) | (value & 65535));
  const lui = (rt, value) => immediate(15, rt, 0, value);
  const ori = (rt, rs, value) => immediate(13, rt, rs, value);
  const addiu = (rt, rs, value) => immediate(9, rt, rs, value);
  const sw = (rt, offset, rs) => immediate(43, rt, rs, offset);
  const shift = (rd, rt, amount) => emit((rt << 16) | (rd << 11) | (amount << 6));
  const or = (rd, rs, rt) => emit((rs << 21) | (rt << 16) | (rd << 11) | 37);
  const label = (name) => labels.set(name, words.length);
  const branch = (op, rs, rt, target) => {
    branches.push({ at: words.length, target });
    immediate(op, rt, rs, 0);
    emit(0);
  };
  const load = (rt, value) => {
    lui(rt, value >>> 16);
    ori(rt, rt, value & 65535);
  };
  // Fill green and blue gradients in two independent RGBA5551 framebuffers.
  load(8, 0xa0100000);
  load(9, 0xa0140000);
  load(10, 38400);
  addiu(11, 0, 0);
  label('fill');
  immediate(12, 12, 11, 31);
  shift(13, 12, 6);
  ori(13, 13, 1);
  shift(14, 13, 16);
  or(13, 13, 14);
  sw(13, 0, 8);
  shift(13, 12, 1);
  ori(13, 13, 1);
  shift(14, 13, 16);
  or(13, 13, 14);
  sw(13, 0, 9);
  addiu(8, 8, 4);
  addiu(9, 9, 4);
  addiu(11, 11, 1);
  addiu(10, 10, -1);
  branch(5, 10, 0, 'fill');
  // One controller-read command, response bytes 3..6, then end-of-packet.
  load(16, 0xa0020000);
  for (let offset = 0; offset < 64; offset += 4) sw(0, offset, 16);
  load(8, 0x01040100);
  sw(8, 0, 16);
  ori(8, 0, 254);
  sw(8, 4, 16);
  ori(8, 0, 1);
  immediate(40, 8, 16, 63);
  // NTSC progressive scanout, 320x240 RGBA5551, no audio DMA.
  load(17, 0xa4400000);
  for (const [offset, value] of [
    [4, 0x00100000],
    [8, 320],
    [12, 2],
    [20, 0x03e52239],
    [24, 525],
    [28, 0x00000c15],
    [32, 0x0c150c15],
    [36, 0x006c02ec],
    [40, 0x002501ff],
    [44, 0x000e0204],
    [48, 0x200],
    [52, 0x400],
    [0, 0x3202],
  ]) {
    load(8, value);
    sw(8, offset, 17);
  }
  load(18, 0xa4800000);
  load(19, 0x1fc007c0);
  load(20, 0x00020000);
  label('poll');
  sw(20, 0, 18);
  sw(19, 16, 18);
  label('writeBusy');
  immediate(35, 8, 18, 24);
  immediate(12, 8, 8, 3);
  branch(5, 8, 0, 'writeBusy');
  sw(20, 0, 18);
  sw(19, 4, 18);
  label('readBusy');
  immediate(35, 8, 18, 24);
  immediate(12, 8, 8, 3);
  branch(5, 8, 0, 'readBusy');
  immediate(36, 8, 16, 3); // A/B/Z/Start/D-pad button byte.
  immediate(36, 9, 16, 4); // C-buttons and L/R shoulder buttons.
  or(8, 8, 9);
  load(9, 0x00100000);
  branch(4, 8, 0, 'present');
  load(9, 0x00140000);
  label('present');
  sw(9, 4, 17);
  sw(0, 24, 18);
  branch(4, 0, 0, 'poll');
  for (const { at, target } of branches) {
    if (!labels.has(target)) throw Error(`Undefined MIPS label: ${target}`);
    words[at] |= (labels.get(target) - at - 1) & 65535;
  }
  if (words.length * 4 > 0xfc0) throw Error('Original N64 program exceeds boot-HLE IPL3 window');
  const bytes = Buffer.alloc(4096);
  bytes.writeUInt32BE(0x80371240, 0);
  bytes.writeUInt32BE(0x80000400, 8);
  bytes.write('ECS ORIGINAL FIBERS', 0x20, 'ascii');
  bytes.write('E', 0x3e, 'ascii');
  for (let index = 0; index < words.length; index++)
    bytes.writeUInt32BE(words[index], 0x40 + index * 4);
  return bytes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3)
    throw Error('Usage: n64-source-original-program.mjs NEW_EXTERNAL_Z64');
  writeFileSync(resolve(process.argv[2]), originalN64Program(), { flag: 'wx' });
}
