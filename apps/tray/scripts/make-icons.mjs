import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/**
 * Draws the tray and application icons.
 *
 * They are generated rather than drawn by hand so the shape is reproducible and
 * so no binary arrives in the repository without a recipe. The glyph is a game
 * cartridge: an outlined body with a label window, which still reads at the
 * sixteen pixels a menu bar gives you.
 */
const here = dirname(fileURLToPath(import.meta.url));
const icons = join(here, '..', 'src-tauri', 'icons');

function roundedRect(x, y, cx, cy, width, height, radius) {
  const dx = Math.abs(x - cx) - (width / 2 - radius);
  const dy = Math.abs(y - cy) - (height / 2 - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

function clamp01(value) {
  return Math.min(Math.max(value, 0), 1);
}

/** Coverage of the cartridge glyph at one point, in a unit square. */
function cartridge(u, v, scale) {
  const body = roundedRect(u, v, 0.5, 0.52, 0.62, 0.74, 0.1);
  const stroke = clamp01(0.5 - (Math.abs(body) - 0.035) * scale);
  const label = roundedRect(u, v, 0.5, 0.34, 0.34, 0.2, 0.045);
  const window = clamp01(0.5 - label * scale);
  const slotLeft = roundedRect(u, v, 0.41, 0.72, 0.06, 0.14, 0.03);
  const slotRight = roundedRect(u, v, 0.59, 0.72, 0.06, 0.14, 0.03);
  const pins = Math.max(clamp01(0.5 - slotLeft * scale), clamp01(0.5 - slotRight * scale));
  return Math.max(stroke, window, pins);
}

function render(size, { background, ink }) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const glyph = cartridge(u, v, scale);
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      if (background) {
        const plate = clamp01(0.5 - roundedRect(u, v, 0.5, 0.5, 1, 1, 0.22) * scale);
        red = background[0];
        green = background[1];
        blue = background[2];
        alpha = plate;
        const mix = glyph * plate;
        red = Math.round(red * (1 - mix) + ink[0] * mix);
        green = Math.round(green * (1 - mix) + ink[1] * mix);
        blue = Math.round(blue * (1 - mix) + ink[2] * mix);
      } else {
        // A macOS template image carries shape in the alpha channel alone.
        red = ink[0];
        green = ink[1];
        blue = ink[2];
        alpha = glyph;
      }
      const at = (y * size + x) * 4;
      pixels[at] = red;
      pixels[at + 1] = green;
      pixels[at + 2] = blue;
      pixels[at + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const at = y * (size * 4 + 1);
    rows[at] = 0;
    pixels.copy(rows, at + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(icons, { recursive: true });
const wanted = [
  ['tray.png', 44, { background: null, ink: [0, 0, 0] }],
  ['icon.png', 512, { background: [22, 24, 26], ink: [232, 230, 227] }],
  ['32x32.png', 32, { background: [22, 24, 26], ink: [232, 230, 227] }],
  ['128x128.png', 128, { background: [22, 24, 26], ink: [232, 230, 227] }],
  ['128x128@2x.png', 256, { background: [22, 24, 26], ink: [232, 230, 227] }],
];
for (const [name, size, palette] of wanted) {
  const bytes = png(size, render(size, palette));
  writeFileSync(join(icons, name), bytes);
  console.log(`${name} ${size}px ${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`);
}

// A PNG-backed ICO preserves the existing glyph and palette. Windows resource
// compilation requires this container even when other platforms use PNGs.
const windowsPng = png(256, render(256, wanted.at(-1)[2]));
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2); // icon, rather than cursor
icoHeader.writeUInt16LE(1, 4); // one image; zero width/height encodes 256px
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(windowsPng.length, 14);
icoHeader.writeUInt32LE(icoHeader.length, 18);
writeFileSync(join(icons, 'icon.ico'), Buffer.concat([icoHeader, windowsPng]));
console.log('icon.ico 256px (PNG container)');
