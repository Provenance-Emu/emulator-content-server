import assert from 'node:assert/strict';
import test from 'node:test';
import { parseManifest } from '@ecs/plugins';
import { playerCatalog } from '../src/player-catalog.js';
import { upstreamCorePins } from '../src/player-catalog-upstream-data.js';

test('source-built Atari and Intellivision cores are installable from immutable central releases', () => {
  for (const [id, system] of [
    ['stella2014', '2600'],
    ['freeintv', 'intellivision'],
    ['atari800', '5200'],
  ]) {
    const matches = playerCatalog.filter((entry) => entry.id === `org.libretro.${id}`);
    assert.equal(matches.length, 1);
    const [entry] = matches;
    assert.equal(entry?.available, true);
    assert.deepEqual(entry.systems, [`com.provenance.${system}`]);
    assert.equal(
      entry.url,
      `https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-${id}-2026.10.31.1/${id}.ecsplayer`,
    );
    assert.match(entry.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.ok((entry.downloadBytes ?? 0) > 0);
  }
});

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
  assert.equal(entries.length, 49);
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
    'org.libretro.doublecherrygb',
    'org.libretro.genesis-plus-gx-wide',
    'org.libretro.gearcoleco',
    'org.libretro.handy',
    'org.libretro.gme',
    'org.libretro.minivmac',
    'org.libretro.mu',
    'org.libretro.neocd',
    'org.libretro.o2em',
    'org.libretro.opera',
    'org.libretro.vecx',
    'org.libretro.vice-x64',
    'org.libretro.vice-xscpu64',
    'org.libretro.fbalpha2012',
  ])
    assert.ok(
      entries.some((entry) => entry.id === id),
      `missing ${id}`,
    );
  const advertisedSystems = entries.flatMap((entry) => entry.systems);
  for (const system of [
    'fds',
    'segacd',
    'pcecd',
    '3DO',
    'colecovision',
    'odyssey2',
    'palmos',
    'macintosh',
    'music',
  ])
    assert.ok(advertisedSystems.includes(`com.provenance.${system}`));
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
        /^https:\/\/web\.libretro\.com\/[A-Za-z0-9_]+_libretro\.(?:js|wasm)$/,
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
    'intellivision',
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
  for (const id of ['org.dolphin.wasm', 'org.flycast.wasm-jit']) {
    const entry = playerCatalog.find((candidate) => candidate.id === id);
    assert.ok(entry);
    assert.equal(entry.available, false);
    assert.equal(entry.url, null);
    assert.equal(entry.sha256, null);
    assert.equal(entry.upstream, undefined);
  }
});

test('catalog refresh retains byte caps, immutable metadata provenance and explicit startup-only limits', () => {
  assert.equal(new Set(upstreamCorePins.map((pin) => pin.id)).size, upstreamCorePins.length);
  for (const pin of upstreamCorePins) {
    assert.ok(pin.loaderBytes <= 8 * 1024 * 1024);
    assert.ok(pin.wasmBytes <= 64 * 1024 * 1024);
    assert.equal(pin.buildVersion, 'web.libretro.com 2026-10-31');
    assert.match(
      pin.sourceInfo,
      /^https:\/\/raw\.githubusercontent\.com\/libretro\/libretro-super\/[a-f0-9]{40}\/dist\/info\/[A-Za-z0-9_]+_libretro\.info$/,
    );
    assert.match(pin.infoSha256, /^[a-f0-9]{64}$/);
    assert.ok(pin.license);
    const entry = playerCatalog.find((entry) => entry.id === pin.id);
    assert.match(entry?.description ?? '', /Experimental.*startup verified.*unverified/);
    assert.equal(entry?.upstream?.manifest.player?.web?.saveCompletion, 'none');
  }
  for (const [id, firmware] of [
    ['gearcoleco', 'colecovision.rom'],
    ['opera', 'panafz1.bin'],
    ['o2em', 'o2rom.bin'],
    ['mu', 'palmos41-en-m515.rom'],
    ['minivmac', 'MacII.ROM'],
  ]) {
    const entry = playerCatalog.find((entry) => entry.id === `org.libretro.${id}`);
    assert.ok(entry?.available);
    assert.ok(entry.description.includes(firmware ?? ''));
  }
  for (const id of ['vecx']) {
    const entry = playerCatalog.find((entry) => entry.id === `org.libretro.${id}`);
    assert.equal(entry?.available, false);
    assert.ok(entry?.reason);
  }
  for (const system of ['segacd', 'pcecd'])
    for (const entry of playerCatalog.filter(
      (entry) => entry.upstream && entry.systems.includes(`com.provenance.${system}`),
    )) {
      assert.ok(entry.upstream?.manifest.player?.web?.contentExtensions.includes('chd'));
      assert.match(entry.description, /requires.*BIOS|requires.*syscard3\.pce/i);
      assert.ok(!entry.upstream?.manifest.player?.web?.contentExtensions.includes('cue'));
    }
});

test('NeoCD stages basename uploads in the declared system subdirectory', () => {
  const entry = playerCatalog.find((entry) => entry.id === 'org.libretro.neocd');
  assert.equal(entry?.available, true);
  assert.equal(entry?.upstream?.manifest.player?.web?.systemFilesDirectory, 'neocd');
  assert.deepEqual(entry?.upstream?.manifest.player?.web?.contentExtensions, ['chd']);
});

test('source-built ProSystem installs use the reproducible central buildbot release', () => {
  const entry = playerCatalog.find((core) => core.id === 'org.libretro.prosystem');
  assert.ok(entry);
  assert.match(entry.url ?? '', /browser-core-prosystem-2026\.10\.31\.1\/prosystem\.ecsplayer$/);
  assert.equal(entry.downloadBytes, 3618571);
  assert.equal(entry.sha256, 'd27dd1248abcda1598418b633f3e71f68fb11dcfb29757e7fb2eec48d0755d55');
});
