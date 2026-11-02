/** Original 16 KiB Supervision cartridge. CPU fills VRAM with shade 1, then counts in RAM. */
export function supervisionSmokeCartridge() {
  const rom = Buffer.alloc(16384, 0xea);
  const code = [
    0x78,
    0xd8,
    0xa2,
    0xff,
    0x9a, // SEI; CLD; LDX #$ff; TXS
    0xa9,
    160,
    0x8d,
    0,
    0x20, // XSIZE=160
    0xa9,
    0,
    0x8d,
    2,
    0x20,
    0x8d,
    3,
    0x20,
    0x8d,
    0x26,
    0x20, // Scroll=0, NMI disabled
    0xa9,
    0x55,
    0xa2,
    0, // Four shade-1 pixels per byte, X=0
  ];
  const fill = code.length;
  for (let page = 0x40; page < 0x60; page++) code.push(0x9d, 0, page); // STA VRAM page,X
  code.push(0xe8, 0xd0, 0); // INX; BNE fill
  code[code.length - 1] = (fill - code.length) & 255;
  const counter = code.length;
  code.push(0xe6, 0x80, 0x4c, counter & 255, 0xc0); // INC $80; JMP counter
  rom.set(code);
  for (const offset of [0x3ffa, 0x3ffc, 0x3ffe]) rom.writeUInt16LE(0xc000, offset);
  return rom;
}
