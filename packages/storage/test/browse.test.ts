import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DomainError } from '@ecs/domain';
import { listFolders, startingPlaces } from '../src/browse.js';

test('browsing lists folders on the server and nothing else', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-browse-')));
  await mkdir(join(base, 'Nintendo 64'));
  await mkdir(join(base, 'Atari'));
  await mkdir(join(base, '.hidden'));
  await writeFile(join(base, 'notes.txt'), 'a file is not a folder', 'utf8');
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'ecs-elsewhere-')));
  await symlink(elsewhere, join(base, 'External drive'));
  await symlink(join(base, 'notes.txt'), join(base, 'notes link'));

  const listing = await listFolders(base);
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ['Atari', 'External drive', 'Nintendo 64'],
    'sorted, no files, no hidden entries, and a linked folder is still a folder',
  );
  assert.equal(listing.path, base);
  assert.equal(listing.parent, await realpath(tmpdir()));
  assert.ok(
    listing.entries.every((entry) => entry.path.startsWith(base)),
    'every entry carries the absolute path the server will resolve',
  );

  const inside = await listFolders(join(base, 'Nintendo 64'));
  assert.deepEqual(inside.entries, []);
  assert.equal(inside.parent, base);
});

test('browsing refuses what it cannot list', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-browse-bad-')));
  await writeFile(join(base, 'rom.bin'), 'bytes', 'utf8');

  const refusals: Array<[string, number]> = [
    ['relative/path', 400],
    [join(base, 'rom.bin'), 400],
    [join(base, 'nothing-here'), 404],
  ];
  for (const [candidate, status] of refusals) {
    await assert.rejects(listFolders(candidate), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.status, status, candidate);
      return true;
    });
  }
});

test('browsing starts somewhere a person recognises', async () => {
  const places = await startingPlaces();
  assert.ok(places.length > 0);
  assert.equal(places[0]?.label, 'Home');
  assert.ok(
    places.every((place) => place.path.startsWith('/') || /^[A-Za-z]:\\/.test(place.path)),
    'a starting place is an absolute path',
  );
});

test('the root of the filesystem has no parent to climb to', async () => {
  const listing = await listFolders('/');
  assert.equal(listing.parent, null);
});

test('iCloud Drive folders are offered by name on a Mac that has them', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ecs-home-')));
  const labels = async () => (await startingPlaces(home)).map((place) => place.label);
  assert.ok(!(await labels()).some((label) => label.includes('iCloud')), 'nothing to offer yet');

  const drive = join(home, 'Library', 'Mobile Documents');
  await mkdir(join(drive, 'com~apple~CloudDocs'), { recursive: true });
  await mkdir(join(drive, 'iCloud~org~provenance-emu~provenance', 'ROMs'), { recursive: true });
  await mkdir(join(drive, 'iCloud~com~joemattiello~iFly'), { recursive: true });
  // A file where a folder is expected is not a place.
  await writeFile(join(drive, 'iCloud~com~joemattiello~iCube'), 'generated', 'utf8');

  const places = await startingPlaces(home);
  const named = (label: string) => places.find((place) => place.label === label)?.path;
  assert.equal(named('iCloud Drive'), join(drive, 'com~apple~CloudDocs'));
  assert.equal(
    named('Provenance in iCloud'),
    join(drive, 'iCloud~org~provenance-emu~provenance', 'ROMs'),
    'points at the games, not at saves and system files beside them',
  );
  assert.equal(named('iFly in iCloud'), join(drive, 'iCloud~com~joemattiello~iFly'));
  assert.equal(named('iCube in iCloud'), undefined);
  assert.equal(places[0]?.label, 'Home');

  // The place can be opened like any other folder.
  const listing = await listFolders(named('Provenance in iCloud') ?? '');
  assert.deepEqual(listing.entries, []);
});
