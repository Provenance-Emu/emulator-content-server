import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CatalogDatabase, MIGRATIONS } from '../src/index.js';

test('DAV credentials are scoped, revocable, secret-free metadata, and reset with account password', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-dav-db-'));
  const filename = join(dir, 'catalog.sqlite');
  const db = new CatalogDatabase(filename);
  try {
    const user = db.createUser({ username: 'reader', passwordHash: 'fixture', actorId: 'test' });
    const input = {
      userId: user.id,
      name: 'Finder',
      username: 'dav-fixture',
      ha1Md5: 'a'.repeat(32),
      ha1Sha256: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
    };
    const created = db.createWebDavCredential(input);
    assert.equal(created.name, 'Finder');
    assert.equal(JSON.stringify(created).includes(input.ha1Md5), false);
    assert.equal(db.listWebDavCredentials(user.id).length, 1);
    assert.equal(db.listWebDavCredentials('other').length, 0);
    assert.equal(db.findWebDavCredential(input.username)?.userId, user.id);
    assert.equal(db.revokeWebDavCredential(created.id, 'other'), false);
    assert.equal(db.revokeWebDavCredential(created.id, user.id), true);
    assert.equal(db.findWebDavCredential(input.username), null);
    assert.ok(db.listWebDavCredentials(user.id)[0]?.revokedAt);
    const next = db.createWebDavCredential({ ...input, username: 'dav-next' });
    assert.ok(db.findWebDavCredential(next.username));
    assert.equal(db.setPassword(user.id, 'new-fixture', user.id, null), true);
    assert.equal(db.findWebDavCredential(next.username), null);
    assert.equal(db.auditContains('create-webdav-credential', input.ha1Md5), false);
    for (const bad of ['', ' a', 'a'.repeat(81)]) {
      assert.throws(() => db.createWebDavCredential({ ...input, name: bad }));
    }
    for (let i = 0; i < 32; i++) db.createWebDavCredential({ ...input, username: `dav-${i}` });
    assert.throws(() => db.createWebDavCredential({ ...input, username: 'dav-limit' }));
    const inspect = new DatabaseSync(filename);
    inspect.prepare('UPDATE webdav_credentials SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    inspect.close();
    assert.equal(db.findWebDavCredential('dav-0'), null);
    assert.ok(db.createWebDavCredential({ ...input, username: 'after-expiry' }));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('version seven upgrades to DAV credentials and opens twice preserving rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-dav-migration-'));
  const filename = join(dir, 'catalog.sqlite');
  try {
    const old = new DatabaseSync(filename);
    for (const migration of MIGRATIONS.slice(0, 7)) {
      old.exec(migration.sql);
      old
        .prepare('INSERT INTO schema_migrations VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
    }
    old.exec(
      "INSERT INTO users VALUES ('user', 'reader', 'fixture', 0, '2026-01-01'); INSERT INTO libraries VALUES ('library', 'Kept', 'user', 1, '2026-01-01', NULL); INSERT INTO storage_locations VALUES ('location', 'Kept drive', '/fixture', '2026-01-01'); INSERT INTO blobs VALUES ('fixture', 12, NULL, NULL, '2026-01-01', 'location');",
    );
    old.close();
    for (let i = 0; i < 2; i++) {
      const db = new CatalogDatabase(filename);
      assert.equal(db.getLibrary('library')?.name, 'Kept');
      assert.equal(db.listStorageLocations()[0]?.id, 'location');
      assert.deepEqual(db.listWebDavCredentials('user'), []);
      assert.equal(db.integrity(), 'ok');
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
