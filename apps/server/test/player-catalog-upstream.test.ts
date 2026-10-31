import assert from 'node:assert/strict';
import test from 'node:test';
import { parseManifest } from '@ecs/plugins';
import { playerCatalog } from '../src/player-catalog.js';

test('Jaguar catalog pins the 3.10.0 HLE package with Jaguar CD support', () => {
  const jaguar = playerCatalog.find((entry) => entry.id === 'org.libretro.virtualjaguar');
  assert.ok(jaguar);
  assert.equal(jaguar.name, 'Virtual Jaguar 3.10.0');
  assert.deepEqual(jaguar.systems, ['com.provenance.jaguar', 'com.provenance.jaguarcd']);
  assert.match(jaguar.description, /profile 1\.2\.0/);
  assert.match(jaguar.description, /CDI\/CHD/);
  assert.match(jaguar.description, /CUE\/BIN/);
  assert.equal(jaguar.available, true);
  assert.equal(
    jaguar.url,
    'https://github.com/Provenance-Emu/emulator-content-server/releases/download/v0.1.6-jaguar-media.1/virtualjaguar.ecsplayer',
  );
  assert.equal(jaguar.sha256, 'b3c8dbd57a7691a2e7335e99f9c2afe120be5a2d229a6f3c0b1994e654e016de');
  assert.equal(jaguar.downloadBytes, 4604920);
});

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

test('requested Provenance systems have a player or an explicit installation blocker', () => {
  for (const system of [
    '2600',
    '5200',
    '7800',
    'gb',
    'gbc',
    'gba',
    'nes',
    'snes',
    'gamegear',
    'vb',
    'jaguar',
    'jaguarcd',
    'dreamcast',
    'naomi',
    'naomi2',
    'atomiswave',
    'gamecube',
    'wii',
  ]) {
    const entries = playerCatalog.filter((entry) =>
      entry.systems.includes(`com.provenance.${system}`),
    );
    assert.ok(entries.length, `missing player status for ${system}`);
    for (const entry of entries) {
      if (!entry.available) assert.ok(entry.reason, `${entry.id} needs an installation blocker`);
    }
  }
  for (const id of ['org.libretro.atari800', 'org.libretro.dolphin', 'org.libretro.flycast']) {
    const entry = playerCatalog.find((candidate) => candidate.id === id);
    assert.ok(entry);
    assert.equal(entry.available, false);
    assert.equal(entry.url, null);
    assert.equal(entry.sha256, null);
    assert.equal(entry.upstream, undefined);
  }
});
