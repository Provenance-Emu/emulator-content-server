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

test('access policy defaults to the local network and survives a second open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-access-'));
  const filename = join(dir, 'library.sqlite');
  const setup = new CatalogDatabase(filename);
  setup.ensureServer('Living Room');
  assert.deepEqual(setup.accessPolicy(), { mode: 'lan', subnets: [] });
  setup.setAccessPolicy({ mode: 'subnets', subnets: ['192.168.4.0/24'], actorId: 'test' });
  setup.close();
  const catalog = new CatalogDatabase(filename);
  try {
    assert.deepEqual(catalog.accessPolicy(), { mode: 'subnets', subnets: ['192.168.4.0/24'] });
    assert.equal(catalog.auditContains('set-access', 'correct-horse'), false);
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('scanned names survive a second open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-sources-'));
  const filename = join(dir, 'library.sqlite');
  const setup = new CatalogDatabase(filename);
  setup.ensureServer('Living Room');
  const user = setup.createUser({
    username: 'owner',
    passwordHash: 'not-a-password-hash',
    actorId: 'test',
  });
  const root = setup.createContentRoot({
    path: '/tmp/ecs-source-fixture',
    label: 'Shelf',
    libraryId: null,
    actorId: user.id,
  });
  assert.equal(
    setup.applyInspection({
      rootId: root.id,
      actorId: user.id,
      online: true,
      files: [
        {
          relativePath: 'nes/sample.nes',
          displayName: 'sample.nes',
          size: 4,
          blocks: 1,
          kind: 'rom',
          systemId: 'com.provenance.nes',
          availability: 'local',
        },
      ],
    }),
    1,
  );
  setup.close();
  const catalog = new CatalogDatabase(filename);
  try {
    const files = catalog.listSources(root.id);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.displayName, 'sample.nes');
    catalog.markRootOffline(root.id);
    assert.equal(catalog.listSources(root.id)[0]?.availability, 'offline');
    assert.equal(catalog.getContentRoot(root.id)?.path, '/tmp/ecs-source-fixture');
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});
