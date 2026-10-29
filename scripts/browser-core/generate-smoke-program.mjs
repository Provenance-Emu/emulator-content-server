/** Original programs for emulator smoke tests. No console firmware or commercial content. */
import { writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 68000 ABS: stop interrupts/objects, show a green background, increment RAM $6000. */
export function jaguarSmokeAbs() {
  const code = Buffer.from([
    // move.w #$2700,sr
    0x46, 0xfc, 0x27, 0x00,
    // clr.l $5000; move.l #4,$5004 (one stop object)
    0x42, 0xb9, 0x00, 0x00, 0x50, 0x00, 0x23, 0xfc, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x50, 0x04,
    // move.l #$50000000,$f00020 (word-swapped object-list pointer)
    0x23, 0xfc, 0x50, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x00, 0x20,
    // move.w #$06c7,$f00028 (enabled RGB16, background, four clocks/pixel)
    0x33, 0xfc, 0x06, 0xc7, 0x00, 0xf0, 0x00, 0x28,
    // move.w #$003f,$f00058 (green); loop: addq.l #1,$6000; bra.s loop
    0x33, 0xfc, 0x00, 0x3f, 0x00, 0xf0, 0x00, 0x58, 0x52, 0xb9, 0x00, 0x00, 0x60, 0x00, 0x60, 0xf8,
  ]);
  const header = Buffer.alloc(0x24);
  header.writeUInt16BE(0x601b, 0);
  header.writeUInt32BE(code.length, 2);
  header.writeUInt32BE(0x4000, 0x16);
  return Buffer.concat([header, code]);
}

/** Original one-MiB cartridge with the standard universal-header/68K entry layout. */
export function jaguarSmokeCartridge() {
  const cartridge = Buffer.alloc(1024 * 1024);
  cartridge[0] = 0xf6; // Standard ten-block marker; no firmware/boot block is copied.
  cartridge.writeUInt32BE(0x04040404, 0x400);
  cartridge.writeUInt32BE(0x00802000, 0x404);
  jaguarSmokeAbs().subarray(0x24).copy(cartridge, 0x2000);
  return cartridge;
}

/** Original two-session CDI. Audio-sector byte order wraps our own 68000 program;
 * the Atari data-header signature is container metadata, not console firmware. */
export function jaguarSmokeCdi() {
  const sectors = 4;
  const trackBytes = sectors * 2352;
  const logical = Buffer.alloc(trackBytes);
  for (let index = 0; index < 16; index++) logical.write('ATRI', 2 + index * 4, 'ascii');
  logical.write('ATARI APPROVED DATA HEADER ATRI ', 0x42, 'ascii');
  const code = jaguarSmokeAbs().subarray(0x24);
  logical.writeUInt32BE(0x4000, 0x62);
  logical.writeUInt32BE(code.length, 0x66);
  code.copy(logical, 0x6a);
  const data = Buffer.alloc(trackBytes);
  for (let index = 0; index < logical.length; index += 2) {
    data[index] = logical[index + 1];
    data[index + 1] = logical[index];
  }
  function descriptor(lba) {
    const parts = [];
    const u32 = (value) => {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32LE(value);
      parts.push(bytes);
    };
    const zero = (length) => parts.push(Buffer.alloc(length));
    u32(0);
    const marker = Buffer.from([0, 0, 1, 0, 0, 0, 255, 255, 255, 255]);
    parts.push(marker, marker);
    zero(4);
    zero(1); // no embedded original filename
    zero(19);
    u32(0);
    zero(2);
    u32(0); // pregap
    u32(sectors);
    zero(6);
    u32(0); // Jaguar data tracks use 2352-byte audio sectors.
    zero(12);
    u32(lba);
    u32(sectors);
    zero(16);
    u32(2); // 2352-byte sector code
    zero(29);
    zero(5);
    u32(0);
    return Buffer.concat(parts);
  }
  const table = Buffer.concat([
    Buffer.from([2, 0, 1, 0]),
    descriptor(0),
    Buffer.alloc(13),
    Buffer.from([1, 0]),
    descriptor(sectors),
    Buffer.alloc(13),
  ]);
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(0x80000006);
  footer.writeUInt32LE(table.length + footer.length, 4);
  return Buffer.concat([Buffer.alloc(trackBytes), data, table, footer]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== 'jaguar')
    throw new Error('Usage: node generate-smoke-program.mjs jaguar NEW_EXTERNAL_PROGRAM.abs');
  const destination = process.argv[3];
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  const within = relative(repository, resolve(destination));
  if (
    !isAbsolute(destination) ||
    (within !== '..' && !within.startsWith('../') && !isAbsolute(within))
  )
    throw new Error('Generate test media outside this repository');
  writeFileSync(destination, jaguarSmokeAbs(), { flag: 'wx' });
}
