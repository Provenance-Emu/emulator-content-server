/** Original BIOS-free 6502 cartridge: enable MARIA, paint green and advance RAM. */
export function atari7800SmokeCode() {
  return Buffer.from([
    0x78,
    0xd8, // SEI, CLD
    0xa9,
    0x07,
    0x85,
    0x01, // native mode, disable BIOS
    0xa9,
    0xc4,
    0x85,
    0x20, // MARIA background: RGB 18,135,0
    0xa9,
    0x81,
    0x85,
    0x2c, // display list list at $8100
    0xa9,
    0x00,
    0x85,
    0x30,
    0xa9,
    0x40,
    0x85,
    0x3c, // enable MARIA DMA
    0xe6,
    0x40,
    0x4c,
    0x16,
    0x80, // increment counter; JMP $8016
  ]);
}
export function atari7800SmokeCartridge() {
  const rom = Buffer.alloc(32768, 0xea);
  atari7800SmokeCode().copy(rom);
  for (let offset = 0x100; offset < 0x160; offset += 3) rom.set([15, 0x82, 0], offset);
  rom.fill(0, 0x200, 0x208); // empty display list: background only
  for (const offset of [0x7ffa, 0x7ffc, 0x7ffe]) rom.writeUInt16LE(0x8000, offset);
  return rom;
}
