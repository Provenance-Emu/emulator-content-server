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
