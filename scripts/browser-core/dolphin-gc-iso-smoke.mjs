/** Original sparse GameCube disc, including a tiny original PPC apploader; no console/game bytes. */
import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dolphinVideoSmokeDol } from './dolphin-video-smoke.mjs';

export function dolphinGcIsoSegments({ logicalSize = 1459978240 } = {}) {
  if (!Number.isSafeInteger(logicalSize) || logicalSize < 0x20020 || logicalSize > 1459978240)
    throw new Error('Original disc size must contain its segments and fit one GameCube disc');
  const dol = dolphinVideoSmokeDol(),
    dolView = new DataView(dol.buffer);
  const entry = dolView.getUint32(0xe0, false),
    codeSize = dolView.getUint32(0x90, false);
  const header = new Uint8Array(0x460),
    view = new DataView(header.buffer);
  header.set(new TextEncoder().encode('GECE00'));
  view.setUint32(0x1c, 0xc2339f3d, false);
  header.set(new TextEncoder().encode('ECS original generated video disc'), 0x20);
  for (const [offset, value] of [
    [0x420, 0x10000],
    [0x424, 0x20000],
    [0x428, 12],
    [0x42c, 12],
    [0x458, 1],
  ])
    view.setUint32(offset, value, false);

  const apploader = new Uint8Array(0x124),
    app = new DataView(apploader.buffer);
  apploader.set(new TextEncoder().encode('2026/10/31'));
  app.setUint32(0x10, 0x81200000, false);
  app.setUint32(0x14, 0x104, false);
  const emitAt = (offset, words) =>
    words.forEach((word, index) => {
      app.setUint32(0x20 + offset + index * 4, word >>> 0, false);
    });
  const load = (reg, value) => [
    (15 << 26) | (reg << 21) | (value >>> 16),
    (24 << 26) | (reg << 21) | (reg << 16) | (value & 0xffff),
  ];
  const stw = (reg, base, offset = 0) => (36 << 26) | (reg << 21) | (base << 16) | offset;
  emitAt(0, [
    ...load(6, 0x81200040),
    stw(6, 3),
    ...load(6, 0x81200060),
    stw(6, 4),
    ...load(6, 0x812000c0),
    stw(6, 5),
    0x4e800020,
  ]);
  emitAt(0x40, [0x3cc08120, 0x38e00000, stw(7, 6, 0x100), 0x4e800020]);
  const main = [
    0x3cc08120,
    0x80e60100,
    0x2c070000,
    0,
    0x38e00001,
    stw(7, 6, 0x100),
    ...load(7, entry),
    stw(7, 3),
    (14 << 26) | (7 << 21) | codeSize,
    stw(7, 4),
    ...load(7, 0x10100),
    stw(7, 5),
    0x38600001,
    0x4e800020,
  ];
  main[3] = 0x40820000 | ((main.length - 3) * 4); // bne to the no-more-sections result
  main.push(0x38600000, 0x4e800020);
  emitAt(0x60, main);
  emitAt(0xc0, [...load(3, entry), 0x4e800020]);
  const fst = new Uint8Array(12),
    fstView = new DataView(fst.buffer);
  fstView.setUint32(0, 0x01000000, false);
  fstView.setUint32(8, 1, false);
  return {
    logicalSize,
    segments: [
      { offset: 0, bytes: header },
      { offset: 0x2440, bytes: apploader },
      { offset: 0x10000, bytes: dol },
      { offset: 0x20000, bytes: fst },
    ],
  };
}

export async function writeDolphinGcIso(path, options) {
  path = resolve(path);
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  const actual = join(await realpath(dirname(path)), path.split(/[\\/]/).at(-1));
  const within = relative(repository, actual);
  if (within !== '..' && !within.startsWith('../') && !isAbsolute(within))
    throw new Error('Generated disc must be outside the repository');
  const disc = dolphinGcIsoSegments(options),
    file = await open(path, 'wx', 0o600);
  try {
    await file.truncate(disc.logicalSize);
    for (const segment of disc.segments) {
      let written = 0;
      while (written < segment.bytes.length) {
        const result = await file.write(
          segment.bytes,
          written,
          segment.bytes.length - written,
          segment.offset + written,
        );
        if (result.bytesWritten === 0) throw new Error('Unable to write original disc segment');
        written += result.bytesWritten;
      }
    }
  } finally {
    await file.close();
  }
  return {
    logicalSize: disc.logicalSize,
    original: true,
    segments: disc.segments.map(({ offset, bytes }) => ({
      offset,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node dolphin-gc-iso-smoke.mjs NEW_EXTERNAL_ISO');
  console.log(JSON.stringify(await writeDolphinGcIso(process.argv[2]), null, 2));
}
