import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DomainError } from '@ecs/domain';
import { CatalogDatabase, MIGRATIONS, pendingMigrations, SCHEMA_VERSION } from '../src/index.js';

function unsupported(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'migration';
}

test('a missing ledger runs every migration and an applied prefix runs the rest', () => {
  assert.deepEqual(pendingMigrations(null), MIGRATIONS);
  const everything = new Set(MIGRATIONS.map((entry) => entry.version));
  assert.deepEqual(pendingMigrations(everything), []);
  for (let applied = 1; applied < MIGRATIONS.length; applied += 1) {
    const prefix = new Set(MIGRATIONS.slice(0, applied).map((entry) => entry.version));
    assert.deepEqual(pendingMigrations(prefix), MIGRATIONS.slice(applied));
  }
});

test('a ledger this build cannot explain is refused instead of guessed', () => {
  assert.throws(() => pendingMigrations(new Set()), unsupported);
  assert.throws(() => pendingMigrations(new Set([SCHEMA_VERSION + 1])), unsupported);
  assert.throws(
    () => pendingMigrations(new Set([...MIGRATIONS.map((entry) => entry.version), 9999])),
    unsupported,
  );
  const second = MIGRATIONS[1];
  if (second) {
    assert.throws(() => pendingMigrations(new Set([second.version])), unsupported);
  }
});

test('an existing catalog opens twice without reapplying a migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-migrate-'));
  const filename = join(dir, 'library.sqlite');
  try {
    const first = new CatalogDatabase(filename);
    const user = first.createUser({
      username: 'owner',
      passwordHash: 'not-a-password-hash',
      actorId: 'test',
    });
    const library = first.createLibrary(user.id, 'Library');
    first.close();

    const second = new CatalogDatabase(filename);
    try {
      assert.equal(second.integrity(), 'ok');
      assert.equal(second.getLibrary(library.id)?.name, 'Library');
    } finally {
      second.close();
    }

    const inspect = new DatabaseSync(filename);
    try {
      const rows = inspect.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      assert.deepEqual(
        rows.map((row) => Number((row as { version: number }).version)),
        MIGRATIONS.map((entry) => entry.version),
      );
    } finally {
      inspect.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a database left at an earlier version is upgraded and keeps its rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-migrate-'));
  const filename = join(dir, 'library.sqlite');
  const first = MIGRATIONS[0];
  assert.ok(first);
  try {
    const earlier = new DatabaseSync(filename);
    earlier.exec(first.sql);
    earlier
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(first.version, new Date().toISOString());
    earlier
      .prepare(
        'INSERT INTO users (id, username, password_hash, is_owner, created_at) VALUES (?, ?, ?, 1, ?)',
      )
      .run('owner-1', 'owner', 'not-a-password-hash', new Date().toISOString());
    earlier.close();

    const upgraded = new CatalogDatabase(filename);
    try {
      assert.equal(upgraded.integrity(), 'ok');
      assert.deepEqual(upgraded.listContentRoots(), [], 'the newer table exists after the upgrade');
      assert.deepEqual(upgraded.listStorageLocations(), []);
      assert.equal(upgraded.writeLocation(), null);
      const saved = upgraded.createContentRoot({
        path: '/not/read/by/this/test',
        label: 'Shelf',
        libraryId: null,
        actorId: 'owner-1',
      });
      assert.equal(upgraded.getContentRoot(saved.id)?.label, 'Shelf');
    } finally {
      upgraded.close();
    }

    const inspect = new DatabaseSync(filename);
    try {
      const user = inspect.prepare('SELECT username FROM users WHERE id = ?').get('owner-1');
      assert.equal((user as { username: string }).username, 'owner');
      const versions = inspect
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((row) => Number((row as { version: number }).version));
      assert.deepEqual(
        versions,
        MIGRATIONS.map((entry) => entry.version),
      );
    } finally {
      inspect.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a tampered ledger is a hard error rather than a partial upgrade', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-migrate-'));
  const filename = join(dir, 'library.sqlite');
  try {
    const created = new CatalogDatabase(filename);
    created.ensureServer('Living Room');
    created.close();

    const forward = new DatabaseSync(filename);
    forward
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(9999, new Date().toISOString());
    forward.close();
    assert.throws(() => new CatalogDatabase(filename), unsupported);

    const emptied = new DatabaseSync(filename);
    emptied.prepare('DELETE FROM schema_migrations').run();
    emptied.close();
    assert.throws(() => new CatalogDatabase(filename), unsupported);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('version 8 upgrades preserve root and source identities and recover interrupted scans twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-v8-'));
  const filename = join(dir, 'catalog.sqlite');
  try {
    const prior = new DatabaseSync(filename);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 8)) {
      prior.exec(migration.sql);
      prior
        .prepare('INSERT INTO schema_migrations VALUES (?, ?)')
        .run(migration.version, '2026-10-20T00:00:00Z');
    }
    prior.exec(`INSERT INTO users VALUES ('owner','owner','fixture',1,'now');
      INSERT INTO libraries VALUES ('library','Library','owner',1,'now',NULL);
      INSERT INTO content_roots VALUES ('root','/never/probed','Shelf','library','now');
      INSERT INTO source_files VALUES ('source','root','generated','Generated',1,1,'rom',NULL,'local','now');`);
    prior.close();
    const actor = {
      kind: 'user',
      userId: 'owner',
      username: 'owner',
      isOwner: true,
      tokenKind: 'session',
      deviceId: null,
      scopes: ['read'],
    } as const;
    const first = new CatalogDatabase(filename);
    assert.equal(first.getSource('source')?.rootId, 'root');
    const summary = first.listContentRootSummaries({ actor: { ...actor, scopes: ['read'] } })[0];
    assert.equal(summary?.scanState, 'unknown');
    assert.equal(summary.indexedFileCount, 1);
    first.beginRootScan('root');
    first.close();
    for (let open = 0; open < 2; open++) {
      const reopened = new CatalogDatabase(filename);
      const recovered = reopened.listContentRootSummaries({
        actor: { ...actor, scopes: ['read'] },
      })[0];
      assert.equal(recovered?.scanState, 'failed');
      assert.equal(recovered.scanError, 'Scan interrupted. Retry scan.');
      assert.ok(recovered.lastScanCompletedAt);
      assert.equal(reopened.getSource('source')?.id, 'source');
      assert.equal(reopened.getContentRoot('root')?.libraryId, 'library');
      assert.equal(reopened.integrity(), 'ok');
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
