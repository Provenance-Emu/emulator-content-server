import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  classifyMedium,
  fileAvailability,
  inferSource,
  inspectRoot,
  probeFile,
  probeRoot,
} from '../src/index.js';
import { darwinMountType } from '../src/volume.js';

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

test('a playlist and its CUE/BIN members form one playable group without changing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ecs-disc-group-'));
  try {
    await mkdir(join(root, 'disc'));
    await writeFile(join(root, 'Game.m3u'), '#EXTM3U\ndisc/Disc 1.cue\ndisc/Disc 2.chd\n');
    const cueBytes = 'FILE "Track 1.bin" BINARY\n TRACK 01 MODE1/2352\n INDEX 01 00:00:00\n';
    await writeFile(join(root, 'disc', 'Disc 1.cue'), cueBytes);
    await writeFile(join(root, 'disc', 'Track 1.bin'), Buffer.from([1, 2, 3]));
    await writeFile(join(root, 'disc', 'Disc 2.chd'), Buffer.from([4, 5]));
    await writeFile(join(root, 'Unrelated.bin'), Buffer.from([6]));
    const result = await inspectRoot(root);
    const files = result.files as ((typeof result.files)[number] & {
      groupMembers?: string[];
      groupAnchor?: string | null;
    })[];
    assert.deepEqual(files.find((f) => f.relativePath === 'Game.m3u')?.groupMembers, [
      'Game.m3u',
      'disc/Disc 1.cue',
      'disc/Track 1.bin',
      'disc/Disc 2.chd',
    ]);
    for (const name of ['disc/Disc 1.cue', 'disc/Track 1.bin', 'disc/Disc 2.chd'])
      assert.equal(files.find((f) => f.relativePath === name)?.groupAnchor, 'Game.m3u');
    assert.equal(files.find((f) => f.relativePath === 'Unrelated.bin')?.groupAnchor ?? null, null);
    assert.equal(await readFile(join(root, 'disc', 'Disc 1.cue'), 'utf8'), cueBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unsafe, missing and cyclic disc references stay visible with a recoverable group error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ecs-disc-bad-'));
  try {
    await writeFile(join(root, 'Escape.cue'), 'FILE "../outside.bin" BINARY\n');
    await writeFile(join(root, 'Missing.cue'), 'FILE "missing.bin" BINARY\n');
    await writeFile(join(root, 'A.m3u'), 'B.m3u\n');
    await writeFile(join(root, 'B.m3u'), 'A.m3u\n');
    const result = await inspectRoot(root);
    for (const file of result.files as ((typeof result.files)[number] & {
      groupError?: string;
      groupAnchor?: string | null;
    })[]) {
      assert.ok(file.groupError, file.relativePath);
      assert.equal(file.groupAnchor ?? null, null);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CloneCD groups preserve uppercase IMG and SUB companions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ecs-clonecd-'));
  try {
    await writeFile(join(root, 'Game.CCD'), '[CloneCD]\nVersion=3\n');
    await writeFile(join(root, 'Game.IMG'), Buffer.from([1]));
    await writeFile(join(root, 'Game.SUB'), Buffer.from([2]));
    const result = await inspectRoot(root);
    assert.deepEqual(result.files.find((file) => file.relativePath === 'Game.CCD')?.groupMembers, [
      'Game.CCD',
      'Game.IMG',
      'Game.SUB',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a partially malformed CUE never hides the files it could parse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ecs-cue-partial-'));
  try {
    await writeFile(
      join(root, 'Game.cue'),
      'FILE "Track.bin" BINARY\nFILE "Missing.bin" INVALID\n',
    );
    await writeFile(join(root, 'Track.bin'), Buffer.from([1]));
    const result = await inspectRoot(root);
    assert.ok(result.files.find((file) => file.relativePath === 'Game.cue')?.groupError);
    assert.equal(result.files.find((file) => file.relativePath === 'Track.bin')?.groupAnchor, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stat identity survives renames without requiring file content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ecs-identity-'));
  try {
    await writeFile(join(root, 'before.nes'), 'generated bytes');
    const before = (await inspectRoot(root)).files[0];
    assert.ok(before);
    assert.match(before.filesystemIdentity ?? '', /^\d+:\d+:\d+$/);
    assert.ok(Number.isFinite(before.mtimeMs));
    await rename(join(root, 'before.nes'), join(root, 'after.nes'));
    const after = (await inspectRoot(root)).files[0];
    assert.ok(after);
    assert.equal(after.filesystemIdentity, before.filesystemIdentity);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.relativePath, 'after.nes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('internal file and directory aliases produce one canonical path per source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ecs-scan-alias-'));
  try {
    await mkdir(join(root, 'nes'));
    await writeFile(join(root, 'nes', 'sample.nes'), 'generated');
    await symlink(join(root, 'nes', 'sample.nes'), join(root, 'alias.nes'));
    await symlink(join(root, 'nes'), join(root, 'alias-directory'));
    const inspected = await inspectRoot(root);
    assert.deepEqual(
      inspected.files.map((file) => file.relativePath),
      ['nes/sample.nes'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an internal directory cycle finishes and includes each canonical source once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ecs-scan-cycle-'));
  try {
    await mkdir(join(root, 'nes'));
    await writeFile(join(root, 'nes', 'sample.nes'), 'generated');
    await symlink(root, join(root, 'nes', 'back'));
    await symlink(join(root, 'nes'), join(root, 'alias-directory'));
    // A child timeout makes a traversal regression fail without leaving an endless walk running.
    const script = `import { inspectRoot } from ${JSON.stringify(new URL('../src/scan.js', import.meta.url).href)};
      console.log(JSON.stringify((await inspectRoot(process.argv[1])).files.map(file => file.relativePath)));`;
    const result = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', script, root],
      { timeout: 5000 },
    );
    assert.deepEqual(JSON.parse(result.stdout), ['nes/sample.nes']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS network mount classification uses the longest complete mount path', () => {
  const facts =
    '/dev/disk1 on / (apfs, local, journaled)\n//player@nas/games on /Volumes/Games (smbfs, nodev, nosuid)\n/dev/disk2 on /Volumes/Games Archive (exfat, local)\n//nas/deeper on /Volumes/Games/Extra (nfs, nodev)';
  assert.equal(darwinMountType('/Volumes/Games/ROMs', facts), 'smbfs');
  assert.equal(darwinMountType('/Volumes/Games Archive/ROMs', facts), 'exfat');
  assert.equal(darwinMountType('/Volumes/Games/Extra/ROMs', facts), 'nfs');
  assert.equal(darwinMountType('/Users/player/Games', facts), 'apfs');
});
