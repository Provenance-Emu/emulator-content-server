/** Original SH4 program: enable RGB565 framebuffer, fill green, count at $8c00f800. */
export function sh4SmokeCode() {
  const words = [],
    literals = [];
  const emit = (word) => words.push(word);
  const load = (register, value) => {
    literals.push({ instruction: words.length * 2, value });
    emit(0xd000 | (register << 8));
  };
  load(0, 0xa05f8044); // FB_R_CTRL: preserve pixel clock, enable RGB565.
  emit(0x6102); // mov.l @r0,r1
  load(2, 0x00800000);
  emit(0x2129); // and r2,r1
  emit(0xe205); // mov #5,r2
  emit(0x212b); // or r2,r1
  emit(0x2012); // mov.l r1,@r0
  load(0, 0xa05f805c);
  load(1, (1 << 20) | (479 << 10) | 319); // 640x480 RGB565.
  emit(0x2012);
  load(0, 0xa05f8050);
  emit(0xe100);
  emit(0x2012); // Read framebuffer starts at VRAM zero.
  load(0, 0xa5000000);
  load(1, 0x07e007e0);
  load(2, (640 * 480) / 2);
  const fill = words.length * 2;
  emit(0x2012); // mov.l r1,@r0
  emit(0x7004); // add #4,r0
  emit(0x4210); // dt r2
  emit(0x8b00 | (((fill - (words.length * 2 + 4)) / 2) & 255)); // bf fill
  load(2, 0x8c00f800);
  emit(0xe300);
  const loop = words.length * 2;
  emit(0x7301); // add #1,r3
  emit(0x2232); // mov.l r3,@r2
  emit(0xa000 | (((loop - (words.length * 2 + 4)) / 2) & 0xfff));
  emit(0x0009); // Delay-slot nop.
  if (words.length % 2) emit(0x0009);
  const code = Buffer.alloc(words.length * 2 + literals.length * 4);
  words.forEach((word, index) => {
    code.writeUInt16LE(word, index * 2);
  });
  literals.forEach(({ instruction, value }, index) => {
    const target = words.length * 2 + index * 4;
    code[instruction] = (target - ((instruction + 4) & ~3)) / 4;
    code.writeUInt32LE(value, target);
  });
  return code;
}

/** ELF32/SH4 little-endian executable, one loadable segment in Dreamcast RAM. */
export function dreamcastSmokeElf() {
  const code = sh4SmokeCode(),
    elf = Buffer.alloc(0x100 + code.length);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]).copy(elf);
  elf.writeUInt16LE(2, 16);
  elf.writeUInt16LE(42, 18); // EM_SH
  elf.writeUInt32LE(1, 20);
  elf.writeUInt32LE(0x8c010000, 24);
  elf.writeUInt32LE(52, 28);
  elf.writeUInt32LE(0x2f, 36); // EF_SH4
  elf.writeUInt16LE(52, 40);
  elf.writeUInt16LE(32, 42);
  elf.writeUInt16LE(1, 44);
  [1, 0x100, 0x8c010000, 0x8c010000, code.length, code.length, 5, 4].forEach((value, index) => {
    elf.writeUInt32LE(value, 52 + index * 4);
  });
  code.copy(elf, 0x100);
  return elf;
}

/** Original unencrypted flat Naomi/Naomi2 cart with the same SH4 program. */
export function naomiSmokeCartridge(naomi2 = false) {
  const code = sh4SmokeCode(),
    cart = Buffer.alloc(0x10000, 0xff);
  cart.fill(0x20, 0, 0x130);
  cart.write(naomi2 ? 'Naomi2' : 'NAOMI', 0, 'ascii');
  cart.write('ECS ORIGINAL GREEN PROGRAM', 0x30, 'ascii');
  cart.writeUInt16LE(1, 0x138);
  cart.writeUInt16LE(0, 0x13a);
  for (const offset of [0x360, 0x3c0]) {
    cart.writeUInt32LE(0x1000, offset);
    cart.writeUInt32LE(0x0c020000, offset + 4);
    cart.writeUInt32LE(code.length, offset + 8);
  }
  cart.writeUInt32LE(0x0c020000, 0x420);
  cart.writeUInt32LE(0x0c020000, 0x424);
  code.copy(cart, 0x1000);
  return cart;
}
