import assert from 'node:assert/strict';
import test from 'node:test';
import { readSkinArchive } from '../src/player/skins/archive.js';
import { selectSkinLayout } from '../src/player/skins/delta.js';
import { skinInfo, skinPdf, skinPng, skinZip } from './skin-fixture.js';

test('Delta PNG/PDF packages share the unified reference plane, combinations and dpad controls', async () => {
  for (const ext of ['png', 'pdf']) {
    const pkg = await readSkinArchive(
      await skinZip(skinInfo('art.' + ext), {
        ['art.' + ext]: ext === 'png' ? skinPng() : skinPdf(),
      }),
    );
    assert.match(pkg.id, /^[a-f0-9]{64}$/);
    assert.equal(pkg.system, 'nes');
    const result = selectSkinLayout(pkg, {});
    assert.equal(result.live, true);
    assert.equal(result.layout.representations.portrait.reference.width, 360);
    assert.equal(result.layout.representations.portrait.controls[1]?.action, 'combo');
    assert.equal(result.layout.representations.portrait.controls[2]?.action, 'dpad');
    assert.ok(result.issues.some((s) => /landscape/i.test(s)));
    assert.equal(pkg.assets.length, 1);
  }
});
test('archive paths, ambiguous names and corruption fail atomically', async () => {
  for (const name of ['../escape.png', '/absolute.png', 'a\\b.png', 'ART.PNG'])
    await assert.rejects(
      readSkinArchive(await skinZip(skinInfo(), { 'art.png': skinPng(), [name]: skinPng() })),
    );
  const zip = await skinZip();
  zip[55] = (zip[55] ?? 0) ^ 0xff;
  await assert.rejects(readSkinArchive(zip));
  await assert.rejects(readSkinArchive(new Uint8Array(32 * 1024 * 1024 + 1)), /limit/i);
});
test('multi-screen, filters and unknown required inputs remain preview-only', async () => {
  const info = skinInfo();
  const r = info.representations.iphone.edgeToEdge.portrait;
  r.screens.push({ outputFrame: { x: 0, y: 270, width: 180, height: 130 } });
  const pkg = await readSkinArchive(await skinZip(info));
  assert.equal(selectSkinLayout(pkg, {}).live, false);
  const bad = skinInfo();
  bad.representations.iphone.edgeToEdge.portrait.items[0]!.inputs = ['unknownAxis'];
  assert.equal(selectSkinLayout(await readSkinArchive(await skinZip(bad)), {}).live, false);
});
test('entry, link, encryption and PNG pixel budgets reject before artwork decode', async () => {
  const { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } = await import('@zip.js/zip.js');
  for (const options of [
    { password: 'secret', zipCrypto: true },
    { externalFileAttributes: 0xa1ff0000 },
  ]) {
    const w = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, ...options });
    await w.add('info.json', new Uint8ArrayReader(new TextEncoder().encode('{}')));
    await assert.rejects(readSkinArchive(await w.close()));
  }
  const w = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 });
  for (let i = 0; i < 257; i++) await w.add('f' + i, new Uint8ArrayReader(new Uint8Array([0])));
  await assert.rejects(readSkinArchive(await w.close()), /entry limit/);
  const png = skinPng();
  new DataView(png.buffer).setUint32(16, 100_000);
  await assert.rejects(
    readSkinArchive(await skinZip(skinInfo(), { 'art.png': png })),
    /pixel limit/,
  );
});

test('animated PNG artwork is rejected before decoding multiple frames', async () => {
  const png = skinPng(),
    chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8);
  chunk.write('acTL', 4);
  chunk.writeUInt32BE(1000, 8);
  const { crc32 } = await import('./skin-fixture.js');
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), 16);
  const animated = new Uint8Array(Buffer.concat([png.slice(0, 33), chunk, png.slice(33)]));
  await assert.rejects(
    readSkinArchive(await skinZip(skinInfo(), { 'art.png': animated })),
    /animated/i,
  );
});
