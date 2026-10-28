import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CatalogDatabase } from '../src/index.js';
import { companionSelection, companionStem } from '../src/source-companions.js';

function file(relativePath: string) {
  return {
    relativePath,
    displayName: relativePath.split('/').at(-1) ?? relativePath,
    size: 1,
    blocks: 1,
    kind: relativePath.endsWith('.nes') ? 'rom' : 'artwork',
    systemId: 'com.provenance.nes',
    availability: 'local' as const,
  };
}
test('companion lookup finds normalized sidecars beyond 50k entries and stays directory scoped', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ecs-companion-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = join(root, 'library.sqlite');
  let db = new CatalogDatabase(filename);
  t.after(() => db.close());
  const owner = db.createUser({ username: 'owner', passwordHash: 'generated', actorId: 'fixture' });
  const library = db.createLibrary(owner.id, 'Large source library');
  const folder = db.createContentRoot({
    path: join(root, 'games'),
    label: 'games',
    libraryId: library.id,
    actorId: owner.id,
  });
  const target = 'Library/CAFÉ.nes';
  const entries = [
    ...Array.from({ length: 50001 }, (_, i) => file(`Library/unrelated-${i}.nes`)),
    file(target),
    file('Library/artwork/Cafe\u0301 front.png'),
    file('Library/CAFÉ (Game Genie).cht'),
    file('Library/patches/other.bps'),
    file('Library/deeper/CAFÉ.png'),
    file('Elsewhere/CAFÉ.png'),
  ];
  db.applyInspection({ rootId: folder.id, actorId: owner.id, online: true, files: entries });
  const found = () =>
    db
      .matchingCompanions(folder.id, target, false)
      .map((f) => f.relativePath)
      .sort();
  assert.deepEqual(
    found(),
    ['Library/CAFÉ (Game Genie).cht', 'Library/artwork/Cafe\u0301 front.png'].sort(),
  );
  assert.deepEqual(
    db
      .matchingCompanions(folder.id, target, true)
      .map((f) => f.relativePath)
      .sort(),
    [...found(), 'Library/patches/other.bps'].sort(),
  );
  const inspection = new DatabaseSync(filename, { readOnly: true });
  const query = companionSelection(folder.id, target, true);
  const plan = inspection
    .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .all(...query.values)
    .map((row) => String(row.detail));
  assert.ok(plan.some((detail) => detail.includes('source_files_match_stem')));
  assert.ok(plan.some((detail) => detail.includes('source_files_match_extension')));
  assert.ok(
    !plan.some((detail) => /SCAN source_files/.test(detail)),
    'no whole-root scan or sorting across every patch',
  );
  inspection.close();
  const sidecar = db.matchingCompanions(folder.id, target, false)[0];
  assert.ok(sidecar);
  const fingerprint = { md5: 'a'.repeat(32), crc32: '12345678', size: 1 };
  db.saveMatchingFingerprint(sidecar.id, 'identity-v1', fingerprint);
  assert.deepEqual({ ...db.matchingFingerprint(sidecar.id, 'identity-v1') }, fingerprint);
  assert.equal(db.matchingFingerprint(sidecar.id, 'identity-v2'), null);
  db.close();
  db = new CatalogDatabase(filename);
  assert.equal(db.integrity(), 'ok');
  assert.equal(found().length, 2);
});

test('companion stems remove explicit artwork roles and find role folders without changing game names', async (t) => {
  assert.equal(companionStem('The Back of Beyond.nes'), 'the back of beyond');
  assert.equal(companionStem('Example - Back.png'), 'example');
  assert.equal(companionStem('Example_CD2.png'), 'example');
  assert.equal(companionStem('Example [CD Label].png'), 'example');
  const root = await mkdtemp(join(tmpdir(), 'ecs-companion-roles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new CatalogDatabase(join(root, 'library.sqlite'));
  t.after(() => db.close());
  const owner = db.createUser({ username: 'owner', passwordHash: 'generated', actorId: 'fixture' });
  const library = db.createLibrary(owner.id, 'Role companions');
  const folder = db.createContentRoot({
    path: join(root, 'games'),
    label: 'games',
    libraryId: library.id,
    actorId: owner.id,
  });
  const target = 'Game/Example.nes';
  db.applyInspection({
    rootId: folder.id,
    actorId: owner.id,
    online: true,
    files: [
      file(target),
      file('Game/manual/Example Manual.pdf'),
      file('Game/discs/Example Disc.png'),
      file('Game/screenshots/Example Screenshot 1.png'),
      file('Game/Example - Back.png'),
      file('Game/Back of Beyond.png'),
    ],
  });
  const found = db
    .matchingCompanions(folder.id, target, false)
    .map((entry) => entry.relativePath)
    .sort();
  assert.deepEqual(
    found,
    [
      'Game/Example - Back.png',
      'Game/discs/Example Disc.png',
      'Game/manual/Example Manual.pdf',
      'Game/screenshots/Example Screenshot 1.png',
    ].sort(),
  );
});
