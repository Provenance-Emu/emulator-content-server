import assert from 'node:assert/strict';
import test from 'node:test';
import { parseManifest } from '@ecs/plugins';
import { playerCatalog } from '../src/player-catalog.js';

test('upstream player catalog entries have valid pinned web-player manifests', () => {
  const entries = playerCatalog.filter((entry) => entry.upstream);
  assert.equal(entries.length, 35);
  for (const id of [
    'org.libretro.prboom',
    'org.libretro.ecwolf',
    'org.libretro.tyrquake',
    'org.libretro.vitaquake2',
  ]) {
    const entry = entries.find((e) => e.id === id);
    assert.ok(entry);
    assert.equal(entry.available, false);
    assert.ok(entry.reason);
  }
  assert.ok(!entries.some((entry) => entry.id === 'org.libretro.pcsx-rearmed'));
  for (const id of [
    'org.libretro.gearboy',
    'org.libretro.mgba',
    'org.libretro.vba-next',
    'org.libretro.gearsystem',
    'org.libretro.snes9x',
    'org.libretro.picodrive',
    'org.libretro.mame2003-plus',
    'org.libretro.fbneo',
    'org.libretro.vice-x64sc',
  ])
    assert.ok(
      entries.some((entry) => entry.id === id),
      `missing ${id}`,
    );
  const advertisedSystems = entries.flatMap((entry) => entry.systems);
  assert.ok(!advertisedSystems.includes('com.provenance.fds'));
  assert.ok(!advertisedSystems.includes('com.provenance.segacd'));
  assert.ok(!advertisedSystems.includes('com.provenance.pcecd'));
  for (const entry of entries) {
    const { upstream } = entry;
    assert.ok(upstream);
    const manifest = parseManifest(upstream.manifest);
    assert.equal(manifest.id, entry.id);
    assert.equal(manifest.kind, 'player');
    assert.deepEqual(manifest.player?.systems, entry.systems);
    assert.equal(manifest.player?.web?.runtime, 'retroarch-emscripten-esm');
    assert.equal(manifest.player?.web?.threaded, false);
    assert.equal(manifest.player?.web?.saveCompletion, 'none');
    assert.ok(
      manifest.player?.web?.contentExtensions.every(
        (extension) => !['cue', 'gdi', 'ccd', 'm3u'].includes(extension),
      ),
    );
    assert.equal(upstream.resources.length, 2);
    assert.equal(
      entry.downloadBytes,
      upstream.resources.reduce((sum, r) => sum + r.sizeBytes, 0),
    );
    for (const resource of upstream.resources) {
      assert.match(
        resource.url,
        /^https:\/\/web\.libretro\.com\/[a-z0-9_]+_libretro\.(?:js|wasm)$/,
      );
      assert.match(resource.sha256, /^[a-f0-9]{64}$/);
      assert.ok(resource.sizeBytes > 0);
    }
  }
});
