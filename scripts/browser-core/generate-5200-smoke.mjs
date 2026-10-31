/** Original 32 KiB Atari 5200 cartridge. Blue GTIA background; RAM counter; no audio. */
export function atari5200SmokeCartridge() {
  const rom = Buffer.alloc(32768, 0xea);
  rom.set([
    0x78,
    0xd8,
    0xa2,
    0xff,
    0x9a, // SEI; CLD; LDX #$ff; TXS
    0xa9,
    0,
    0x8d,
    0x0e,
    0xd4,
    0x8d,
    0,
    0xd4, // NMIEN=0; DMACTL=0
    0xa9,
    0x86,
    0x8d,
    0x1a,
    0xc0, // GTIA COLBK=$86
    0xe6,
    0x80,
    0x4c,
    0x12,
    0x40, // INC $80; JMP $4012
  ]);
  rom.fill(0, 0x7fe8, 0x7ffe); // Original blank title/header
  rom[0x7ffd] = 0xff; // Skip title screen
  rom.writeUInt16LE(0x4000, 0x7ffe); // Cartridge entry point
  return rom;
}
