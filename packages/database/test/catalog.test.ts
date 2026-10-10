import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DomainError } from '@ecs/domain';
import { CatalogDatabase } from '../src/index.js';

test('migrations, revision conflicts, and backups survive a second connection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-db-'));
  const filename = join(dir, 'library.sqlite');
  const setup = new CatalogDatabase(filename);
  setup.ensureServer('Living Room');
  setup.close();
  const catalog = new CatalogDatabase(filename);
  try {
    assert.equal(catalog.integrity(), 'ok');
    assert.equal(catalog.server().bootstrapped, false);
    const user = catalog.createUser({
      username: 'owner',
      passwordHash: 'not-a-password-hash',
      actorId: 'test',
    });
    const library = catalog.createLibrary(user.id, 'Library');
    const item = catalog.createItem({
      libraryId: library.id,
      systemIdentifier: 'com.provenance.nes',
      title: 'Example',
      md5: null,
      crc: null,
      actorId: user.id,
    });
    assert.throws(
      () =>
        catalog.updateItem({
          id: item.id,
          baseRevision: 9,
          title: 'Stale',
          actorId: user.id,
        }),
      (error: unknown) => error instanceof DomainError && error.code === 'conflict',
    );
    const backup = join(dir, 'backup.sqlite');
    catalog.backupTo(backup);
    const restored = new CatalogDatabase(backup);
    try {
      assert.equal(restored.getItem(item.id)?.title, 'Example');
    } finally {
      restored.close();
    }
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});
