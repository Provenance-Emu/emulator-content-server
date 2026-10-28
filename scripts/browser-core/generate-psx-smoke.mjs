/** Original MIPS-I program; no Sony firmware, SDK, game, or third-party executable. */
export function psxSmokeCode() {
  const words = [];
  const emit = (word) => words.push(word >>> 0);
  const load = (register, value) => {
    emit(0x3c000000 | (register << 16) | (value >>> 16)); // lui
    emit(0x34000000 | (register << 21) | (register << 16) | (value & 0xffff)); // ori
  };
  const store = (register, addressRegister, offset = 0) =>
    emit(0xac000000 | (addressRegister << 21) | (register << 16) | offset);
  load(8, 0x1f801810); // GP0; GP1 is the next word.
  for (const value of [0, 0x03000000, 0x05000000, 0x06c60260, 0x07042018, 0x08000001]) {
    load(9, value);
    store(9, 8, 4);
  }
  // GPU fill command: green, (0,0), 320x240.
  for (const value of [0x0200ff00, 0, 0x00f00140]) {
    load(9, value);
    store(9, 8);
  }
  load(10, 0x80020000); // Guest progress counter outside program and HLE work area.
  load(11, 0);
  load(12, 0x0200ff00);
  load(13, 0x00010010); // Refresh a 16x1 green strip without a full-screen fill each loop.
  const loop = words.length;
  store(12, 8);
  store(0, 8);
  store(13, 8);
  emit(0x256b0001); // addiu t3,t3,1
  store(11, 10);
  emit(0x10000000 | ((loop - (words.length + 1)) & 0xffff)); // beq zero,zero,loop
  emit(0); // Branch delay slot nop.
  const code = Buffer.alloc(words.length * 4);
  words.forEach((word, index) => {
    code.writeUInt32LE(word, index * 4);
  });
  return code;
}

/** Sector-aligned PS-X EXE with explicit entry, RAM load address, and valid stack. */
export function psxSmokeExe() {
  const code = psxSmokeCode(),
    dataSize = Math.ceil(code.length / 0x800) * 0x800;
  const exe = Buffer.alloc(0x800 + dataSize);
  exe.write('PS-X EXE', 0, 'ascii');
  exe.writeUInt32LE(0x80010000, 0x10);
  exe.writeUInt32LE(0x80010000, 0x18);
  exe.writeUInt32LE(dataSize, 0x1c);
  exe.writeUInt32LE(0x801fff00, 0x30);
  code.copy(exe, 0x800);
  return exe;
}
