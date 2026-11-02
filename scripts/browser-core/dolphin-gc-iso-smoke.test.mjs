import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateDolphinDol } from './dolphin-abi.mjs';
import { dolphinGcIsoSegments, writeDolphinGcIso } from './dolphin-gc-iso-smoke.mjs';
import { dolphinVideoSmokeDol } from './dolphin-video-smoke.mjs';

test('Wii program preserves HID4 mapping, uses reserved-safe addresses, and keeps the accepted GC fixture', () => {
  const gc = dolphinVideoSmokeDol();
  assert.equal(
    createHash('sha256').update(gc).digest('hex'),
    '7d6123b0dad9d74883586dd366b10774a7b411ff5d177d3464ea7bdac6084ce7',
  );
  const wii = dolphinVideoSmokeDol({ wii: true });
  assert.deepEqual(validateDolphinDol(wii), { entry: 0x80008000, counter: 0x8000f800 });
  const view = new DataView(wii.buffer);
  assert.equal(
    view.getUint32(0x100, false),
    0x7c13faa6,
    'read HID4 before writing: clearing it disables MEM2 mappings',
  );
  assert.equal(
    view.getUint32(0x104, false),
    0x7c13fba6,
    'Wii-only HID4 opcode selects Wii executable boot',
  );
  assert.ok(
    view.getUint32(0x48, false) > 0x800031ff,
    'do not overwrite Wii IOS boot low-memory fields',
  );
});

test('sparse GC disc describes bounded independent segments and a real apploader/DOL/FST', () => {
  const disc = dolphinGcIsoSegments();
  assert.equal(disc.logicalSize, 1459978240);
  assert.ok(disc.segments.reduce((size, segment) => size + segment.bytes.length, 0) < 4096);
  let end = 0;
  for (const segment of disc.segments) {
    assert.ok(segment.offset >= end);
    end = segment.offset + segment.bytes.length;
    assert.ok(end <= disc.logicalSize);
  }
  const header = new DataView(disc.segments[0].bytes.buffer);
  assert.equal(header.getUint32(0x1c, false), 0xc2339f3d);
  const dol = disc.segments.find(({ offset }) => offset === header.getUint32(0x420, false));
  assert.deepEqual(validateDolphinDol(dol.bytes), { entry: 0x80003100, counter: 0x80004000 });
  const fst = disc.segments.find(({ offset }) => offset === header.getUint32(0x424, false));
  assert.equal(header.getUint32(0x428, false), fst.bytes.length);
  assert.equal(new DataView(fst.bytes.buffer).getUint32(8, false), 1, 'valid root-only FST');
  const app = new DataView(disc.segments.find(({ offset }) => offset === 0x2440).bytes.buffer);
  assert.equal(app.getUint32(0x10, false), 0x81200000);
  assert.equal(app.getUint32(0x14, false) + 0x20, app.byteLength);
  for (const logicalSize of [NaN, 0x20000, 1459978241, 1.5])
    assert.throws(() => dolphinGcIsoSegments({ logicalSize }), /disc size/);
});

test('writer emits a large sparse disc without overwriting operator files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-generated-disc-test-'));
  try {
    const path = join(directory, 'original.iso');
    const receipt = await writeDolphinGcIso(path);
    const metadata = await stat(path);
    assert.equal(metadata.size, receipt.logicalSize);
    if (metadata.blocks !== undefined)
      assert.ok(metadata.blocks * 512 < 1024 * 1024, 'logical disc must remain sparse');
    const file = await open(path, 'r');
    try {
      for (const segment of dolphinGcIsoSegments().segments) {
        const actual = new Uint8Array(segment.bytes.length);
        assert.equal(
          (await file.read(actual, 0, actual.length, segment.offset)).bytesRead,
          actual.length,
        );
        assert.deepEqual(actual, segment.bytes);
      }
      const hole = new Uint8Array(16).fill(0xff);
      await file.read(hole, 0, hole.length, 800 * 1024 * 1024);
      assert.ok(hole.every((byte) => byte === 0));
    } finally {
      await file.close();
    }
    const occupied = join(directory, 'existing.iso');
    await writeFile(occupied, 'operator data');
    await assert.rejects(writeDolphinGcIso(occupied), { code: 'EEXIST' });
    assert.equal(await readFile(occupied, 'utf8'), 'operator data');
    await assert.rejects(
      writeDolphinGcIso(new URL('./must-not-write.iso', import.meta.url).pathname),
      /outside the repository/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
