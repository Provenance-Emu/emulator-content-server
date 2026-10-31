/** Original SM83 Mega Duck cartridge. Shade 1 background becomes shade 3 while A is held. */
export function megaDuckSmokeCartridge() {
  const rom = Buffer.alloc(32768, 0);
  const code = [],
    labels = new Map(),
    fixes = [];
  const emit = (...b) => code.push(...b);
  const label = (name) => labels.set(name, code.length);
  const jr = (op, name) => {
    emit(op, 0);
    fixes.push([code.length - 1, name]);
  };
  emit(0xf3, 0x31, 0xfe, 0xff, 0xaf, 0xe0, 0x10); // DI, SP, LCD off
  emit(0x21, 0, 0x80, 0x06, 8); // Tile 0: shade 1
  label('tile');
  emit(0x3e, 0xff, 0x22, 0xaf, 0x22, 0x05);
  jr(0x20, 'tile');
  emit(0x21, 0, 0x98, 0x01, 0, 4); // Clear tile map
  label('map');
  emit(0x36, 0, 0x23, 0x0b, 0x78, 0xb1);
  jr(0x20, 'map');
  emit(0xaf, 0xe0, 0x12, 0xe0, 0x13, 0x3e, 4, 0xe0, 0x1b, 0x3e, 0xd0, 0xe0, 0x10);
  label('poll');
  emit(0x3e, 0x10, 0xe0, 0, 0xf0, 0, 0xe6, 1);
  jr(0x28, 'pressed');
  emit(0x3e, 4);
  jr(0x18, 'palette');
  label('pressed');
  emit(0x3e, 0x0c);
  label('palette');
  emit(0xe0, 0x1b, 0x21, 0, 0xc0, 0x34);
  jr(0x18, 'poll');
  for (const [offset, name] of fixes) code[offset] = (labels.get(name) - offset - 1) & 255;
  rom.set(code);
  return rom;
}
