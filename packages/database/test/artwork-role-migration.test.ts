import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CatalogDatabase, MIGRATIONS } from '../src/index.js';
import { companionDirectory, companionExtension, companionStem } from '../src/source-companions.js';

test('a catalog without the banner kind keeps every saved selection and its bytes, then accepts a banner', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-artwork-role-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'library.sqlite');
  const old = new DatabaseSync(filename);
  // Earlier migrations call the functions the catalog registers on its own connection.
  old.function('ecs_companion_parent', { deterministic: true }, (value) =>
    companionDirectory(String(value ?? '')),
  );
  old.function('ecs_companion_stem', { deterministic: true }, (value) =>
    companionStem(String(value ?? '')),
  );
  old.function('ecs_companion_extension', { deterministic: true }, (value) =>
    companionExtension(String(value ?? '')),
  );
  for (const migration of MIGRATIONS.filter((m) => m.version <= 24)) {
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
  for (const id of ['game', 'other-game'])
    old
      .prepare(
        'INSERT INTO source_files(id,root_id,relative_path,display_name,size,blocks,kind,availability,scanned_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(id, 'root', `${id}.nes`, `${id}.nes`, 1, 1, 'rom', 'local', 'generated-date');
  const selection = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
    id,
    providerId: 'manual',
    kind,
    title: 'Owner selected title',
    confidence: 'local',
    metadata: { title: 'Owner selected title' },
    originKind: null,
    contentAvailable: kind !== 'metadata',
    contentType: kind === 'artwork' ? 'image/png' : null,
    fileName: kind === 'metadata' ? null : `${id}.bin`,
    updatedAt: 'generated-date',
    ...extra,
  });
  const front = new Uint8Array([137, 80, 78, 71, 1]);
  // Larger than a cover may be, as a scanned manual page is allowed to be.
  const manual = new Uint8Array(3 * 1024 * 1024).fill(7);
  const patch = new Uint8Array([80, 65, 84, 67, 72]);
  const rows: [string, string, string, object, Uint8Array | null][] = [
    ['game', 'metadata', '', selection('details', 'metadata'), null],
    ['game', 'artwork', 'front', selection('front', 'artwork'), front],
    ['game', 'artwork', 'manual', selection('manual', 'artwork'), manual],
    ['game', 'patch', '', selection('patch', 'patch'), patch],
    ['other-game', 'artwork', 'screenshot', selection('shot', 'artwork'), front],
  ];
  const insert = old.prepare(
    'INSERT INTO source_match_selections(source_id,kind,artwork_role,selection_json,content) VALUES(?,?,?,?,?)',
  );
  for (const [source, kind, role, json, content] of rows)
    insert.run(source, kind, role, JSON.stringify(json), content);
  old.prepare('INSERT INTO source_match_state(source_id,revision) VALUES(?,?)').run('game', 7);
  // The catalog before this change refuses the new kind.
  assert.throws(() => insert.run('game', 'artwork', 'banner', '{}', null));
  old.close();

  for (let pass = 0; pass < 2; pass++) {
    const db = new CatalogDatabase(filename);
    try {
      assert.equal(db.integrity(), 'ok');
      const saved = db.sourceMatches('game');
      assert.equal(saved.revision, 7 + pass);
      assert.deepEqual(
        saved.matches.filter((match) => match.artworkRole !== 'banner'),
        [
          { ...selection('front', 'artwork'), artworkRole: 'front' },
          { ...selection('manual', 'artwork'), artworkRole: 'manual' },
          selection('details', 'metadata'),
          selection('patch', 'patch'),
        ],
      );
      assert.deepEqual(db.sourceMatchContent('game', 'artwork', 'front'), front);
      assert.deepEqual(db.sourceMatchContent('game', 'artwork', 'manual'), manual);
      assert.deepEqual(db.sourceMatchContent('game', 'patch'), patch);
      assert.deepEqual(db.sourceMatchContent('other-game', 'artwork', 'screenshot'), front);
      // Bytes saved before digests were kept are given one, so a listing can name them.
      const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
      assert.equal(db.sourceMatchContentDigest('game', 'artwork', 'front'), digest(front));
      assert.equal(db.sourceMatchContentDigest('game', 'artwork', 'manual'), digest(manual));
      assert.equal(db.sourceMatchContentDigest('game', 'metadata'), null);
      assert.equal(db.getSource('game')?.artworkVersion, digest(front));
      assert.equal(db.getSource('other-game')?.artworkVersion, undefined);
      assert.equal(db.sourceMatches('other-game').matches.length, 1);
      if (pass === 0) {
        const banner = new Uint8Array([137, 80, 78, 71, 2]);
        const after = db.saveSourceMatch(
          'game',
          7,
          'artwork',
          {
            ...selection('banner', 'artwork'),
            artworkRole: 'banner',
          } as Parameters<CatalogDatabase['saveSourceMatch']>[3],
          banner,
          'owner',
          'banner',
        );
        assert.equal(after.revision, 8);
        assert.deepEqual(db.sourceMatchContent('game', 'artwork', 'banner'), banner);
        assert.equal(db.sourceMatchContentDigest('game', 'artwork', 'banner'), digest(banner));
      } else {
        // The banner saved on the first open is still there on the second.
        assert.equal(db.sourceMatchContent('game', 'artwork', 'banner')?.byteLength, 5);
      }
    } finally {
      db.close();
    }
  }

  const raw = new DatabaseSync(filename);
  try {
    assert.deepEqual(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE 'source_match_selections%' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name)
        .filter((name) => !name.startsWith('sqlite_autoindex')),
      ['source_match_selections'],
    );
    // An unknown kind of picture is still refused by the catalog itself.
    assert.throws(() =>
      raw
        .prepare(
          'INSERT INTO source_match_selections(source_id,kind,artwork_role,selection_json,content) VALUES(?,?,?,?,?)',
        )
        .run('game', 'artwork', 'poster', '{}', null),
    );
  } finally {
    raw.close();
  }
});
