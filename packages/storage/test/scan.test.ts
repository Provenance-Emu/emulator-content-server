import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  classifyMedium,
  fileAvailability,
  inferSource,
  inspectRoot,
  probeFile,
  probeRoot,
} from '../src/index.js';

test('a placeholder on a file provider is evicted and a missing volume is offline', () => {
  assert.equal(
    fileAvailability({ online: true, medium: 'icloud', size: 4096, blocks: 0 }),
    'evicted',
  );
  assert.equal(
    fileAvailability({ online: true, medium: 'internal', size: 4096, blocks: 0 }),
    'local',
  );
  assert.equal(
    fileAvailability({ online: false, medium: 'removable', size: 4096, blocks: 8 }),
    'offline',
  );
  assert.equal(
    classifyMedium({
      path: '/Volumes/Games',
      platform: 'darwin',
      home: '/Users/player',
      sameDeviceAsSystem: false,
      fstype: null,
    }),
    'removable',
  );
  assert.equal(
    classifyMedium({
      path: '/Volumes/Share',
      platform: 'darwin',
      home: '/Users/player',
      sameDeviceAsSystem: false,
      fstype: 'smbfs',
    }),
    'network',
  );
  assert.equal(
    classifyMedium({
      path: '/Users/player/Library/Mobile Documents/com~apple~CloudDocs/Games',
      platform: 'darwin',
      home: '/Users/player',
      sameDeviceAsSystem: true,
      fstype: 'apfs',
    }),
    'icloud',
  );
  assert.equal(
    classifyMedium({
      path: '/Users/player/Games',
      platform: 'darwin',
      home: '/Users/player',
      sameDeviceAsSystem: true,
      fstype: 'apfs',
    }),
    'internal',
  );
});

test('a scan names generated files and does not change their bytes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ecs-scan-'));
  const root = join(parent, 'library');
  const folder = join(root, 'nes');
  await mkdir(folder, { recursive: true });
  const file = join(folder, 'sample.nes');
  await writeFile(file, 'generated-bytes');
  const outside = join(parent, 'outside.txt');
  await writeFile(outside, 'nope');
  await symlink(outside, join(folder, 'escape.txt'));
  try {
    const inspected = await inspectRoot(root);
    assert.equal(inspected.online, true);
    assert.equal(inspected.files.length, 1);
    assert.equal(inspected.files[0]?.relativePath, 'nes/sample.nes');
    assert.equal(inspected.files[0]?.kind, 'rom');
    assert.equal(inspected.files[0]?.systemId, 'com.provenance.nes');
    assert.equal(inspected.files[0]?.availability, 'local');
    assert.equal(await readFile(file, 'utf8'), 'generated-bytes');
    const missing = await probeFile(join(root, 'gone.nes'), inspected.medium, true);
    assert.equal(missing.availability, 'offline');
    const unplugged = await probeRoot('/Volumes/ecs-not-a-volume');
    assert.equal(unplugged.online, false);
    assert.equal(unplugged.medium, 'removable');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// A disc extension identifies a container, not a console; folder hints disambiguate it.
test('system inference recognizes common folder names and leaves ambiguous discs unresolved', () => {
  for (const [path, kind, systemId] of [
    ['Atari Jaguar/Game.j64', 'rom', 'com.provenance.jaguar'],
    ['Nintendo - Game Boy Advance/Game.zip', 'rom', 'com.provenance.gba'],
    ['Sega Saturn/Game.cue', 'rom', 'com.provenance.saturn'],
    ['jaguar-roms-private/Game.cue', 'rom', 'com.provenance.jaguar'],
    ['Game.cue', 'rom', null],
    ['Game.cdi', 'rom', null],
    ['CDI/Game.cdi', 'rom', null],
    ['Atari Jaguar CD/CDI/Game.cdi', 'rom', 'com.provenance.jaguarcd'],
    ['Dreamcast/Game.cdi', 'rom', 'com.provenance.dreamcast'],
    ['Atari Jaguar CD/Game.cdi', 'rom', 'com.provenance.jaguarcd'],
    ['PlayStation 2/Game.iso', 'rom', 'com.provenance.ps2'],
    ['Game.bin', 'rom', null],
    ['Game.gg', 'rom', 'com.provenance.gamegear'],
    ['nes/snes/Game.zip', 'rom', 'com.provenance.snes'],
    ['covers/Game.png', 'artwork', null],
    ['Game.ips', 'system_file', null],
  ] as const)
    assert.deepEqual(inferSource(path), { kind, systemId }, path);
});
