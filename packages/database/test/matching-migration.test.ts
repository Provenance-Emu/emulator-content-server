import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CatalogDatabase, MIGRATIONS } from '../src/index.js';

test('a pre-queue catalog retains source selections while companion indexes backfill without a folder rescan', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-legacy-matching-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'library.sqlite'),
    old = new DatabaseSync(filename);
  for (const migration of MIGRATIONS.filter((m) => m.version <= 15)) {
    old.exec(migration.sql);
    old
      .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
      .run(migration.version, 'generated-date');
  }
  old
    .prepare('INSERT INTO users(id,username,password_hash,is_owner,created_at) VALUES(?,?,?,?,?)')
    .run('owner', 'owner', 'generated', 1, 'generated-date');
  old
    .prepare('INSERT INTO libraries(id,name,owner_id,revision,created_at) VALUES(?,?,?,?,?)')
    .run('library', 'Original library', 'owner', 1, 'generated-date');
  old
    .prepare('INSERT INTO content_roots(id,path,label,library_id,created_at) VALUES(?,?,?,?,?)')
    .run('root', join(directory, 'never-opened'), 'Existing folder', 'library', 'generated-date');
  for (const [id, path, kind] of [
    ['game', 'CAFÉ.nes', 'rom'],
    ['art', 'artwork/Cafe\u0301 front.png', 'artwork'],
  ])
    old
      .prepare(
        'INSERT INTO source_files(id,root_id,relative_path,display_name,size,blocks,kind,availability,scanned_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id ?? '',
        'root',
        path ?? '',
        path?.split('/').at(-1) ?? '',
        1,
        1,
        kind ?? 'rom',
        'local',
        'generated-date',
      );
  const chosen = {
    id: 'preserved',
    kind: 'metadata',
    title: 'Owner selected title',
    metadata: { title: 'Owner selected title' },
  };
  old.prepare('INSERT INTO source_match_state(source_id,revision) VALUES(?,?)').run('game', 3);
  old
    .prepare(
      'INSERT INTO source_match_selections(source_id,kind,selection_json,content) VALUES(?,?,?,?)',
    )
    .run('game', 'metadata', JSON.stringify(chosen), null);
  old.close();
  for (let i = 0; i < 2; i++) {
    const db = new CatalogDatabase(filename);
    try {
      assert.equal(db.integrity(), 'ok');
      assert.equal(db.getContentRoot('root')?.libraryId, 'library');
      assert.equal(db.sourceMatches('game').revision, 3);
      assert.deepEqual(db.sourceMatches('game').matches, [chosen]);
      assert.deepEqual(
        db.matchingCompanions('root', 'CAFÉ.nes', false).map((s) => s.id),
        ['art'],
      );
      assert.equal(db.libraryJobs.list().length, 0);
    } finally {
      db.close();
    }
  }
});
