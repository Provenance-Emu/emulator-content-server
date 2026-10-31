import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { softwareCoreManifest, softwareCorePlan } from './build-software-core.mjs';

test('software build plans select static single-thread targets and reject arbitrary build inputs', () => {
  const plan = softwareCorePlan('stella2014');
  assert.ok(plan.coreFlags.includes('platform=emscripten'));
  assert.ok(plan.coreFlags.includes('GIT_VERSION=" 7d1361e"'));
  assert.ok(plan.frontendFlags.includes('LIBRETRO=stella2014'));
  assert.ok(plan.frontendFlags.includes('HAVE_THREADS=0'));
  assert.ok(plan.frontendFlags.includes('HAVE_AUDIOWORKLET=0'));
  assert.throws(() => softwareCorePlan('prosystem'), /software recipe/);
  assert.throws(() => softwareCorePlan('../../custom'), /software recipe/);
});

test('software packages bind actual artifacts to system, extension and firmware-free manifests', () => {
  const loader = Buffer.from('export default () => {};'),
    wasm = Buffer.from([0, 97, 115, 109]);
  const cases = [
    ['stella2014', 'com.provenance.2600', ['a26', 'bin'], 1048576],
    ['freeintv', 'com.provenance.intellivision', ['int', 'bin', 'rom'], 1048576],
    ['atari800', 'com.provenance.5200', ['a52', 'car', 'bin', 'rom'], 1048576],
  ];
  for (const [id, system, extensions, maxContentBytes] of cases) {
    const manifest = softwareCoreManifest(id, loader, wasm);
    assert.equal(manifest.id, `org.libretro.${id}`);
    assert.deepEqual(manifest.player.systems, [system]);
    assert.deepEqual(manifest.player.web.contentExtensions, extensions);
    assert.equal(manifest.player.web.maxContentBytes, maxContentBytes);
    assert.equal(manifest.player.web.saveCompletion, 'none');
    assert.equal(manifest.player.web.threaded, false);
    assert.deepEqual(manifest.player.web.assets, []);
    assert.equal(
      manifest.player.web.loader.sha256,
      createHash('sha256').update(loader).digest('hex'),
    );
    assert.equal(manifest.player.web.wasm.sha256, createHash('sha256').update(wasm).digest('hex'));
  }
});
