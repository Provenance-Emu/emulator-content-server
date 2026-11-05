/** Entirely original 4 KiB Atari 2600 cartridge; blue frame, no sound. */
export function atari2600SmokeCartridge() {
  const code = [],
    labels = new Map(),
    branches = [];
  const emit = (...bytes) => code.push(...bytes);
  const label = (name) => labels.set(name, code.length);
  const branch = (opcode, name) => {
    emit(opcode, 0);
    branches.push([code.length - 1, name]);
  };
  emit(0x78, 0xd8, 0xa2, 0xff, 0x9a); // SEI; CLD; LDX #$ff; TXS
  emit(0xa9, 0, 0x85, 0x19, 0x85, 0x1a); // AUDV0/AUDV1 = 0
  label('frame');
  emit(0xa9, 2, 0x85, 1, 0x85, 0); // VBLANK=2; VSYNC=2
  emit(0xa2, 3);
  label('sync');
  emit(0x85, 2, 0xca);
  branch(0xd0, 'sync');
  emit(0xa9, 0, 0x85, 0, 0xa2, 37); // VSYNC=0, 37 blank lines
  label('blank');
  emit(0x85, 2, 0xca);
  branch(0xd0, 'blank');
  emit(0x85, 1, 0xa9, 0x86, 0x85, 9, 0xa2, 192); // VBLANK=0; COLUBK=$86
  label('picture');
  emit(0x85, 2, 0xca);
  branch(0xd0, 'picture');
  emit(0xa9, 2, 0x85, 1, 0xa2, 30);
  label('overscan');
  emit(0x85, 2, 0xca);
  branch(0xd0, 'overscan');
  emit(0xe6, 0x80, 0x4c, (0xf000 + labels.get('frame')) & 255, 0xf0); // RAM frame counter; JMP
  for (const [offset, name] of branches) code[offset] = (labels.get(name) - offset - 1) & 255;
  const rom = Buffer.alloc(4096, 0xea);
  rom.set(code);
  for (const offset of [0xffa, 0xffc, 0xffe]) rom.writeUInt16LE(0xf000, offset);
  return rom;
}
