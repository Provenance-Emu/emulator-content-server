import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CatalogDatabase } from '../src/index.js';

test('folder watching defaults off, persists across reopen, and disconnect removes consent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-watch-policy-'));
  const filename = join(directory, 'catalog.sqlite');
  let catalog = new CatalogDatabase(filename);
  try {
    catalog.ensureServer('Generated');
    const owner = catalog.createUser({
      username: 'owner',
      passwordHash: 'generated',
      actorId: 'test',
    });
    const root = catalog.createContentRoot({
      path: '/generated/watch-root',
      label: 'Generated',
      libraryId: null,
      actorId: owner.id,
    });
    assert.deepEqual(catalog.listFolderWatchPolicies(), []);
    catalog.setFolderWatchPolicy(root.id, owner.id);
    catalog.setFolderWatchPolicy(root.id, owner.id);
    const expected = [{ rootId: root.id, rootPath: root.path, enabledBy: owner.id }];
    assert.deepEqual(catalog.listFolderWatchPolicies(), expected);
    catalog.close();
    catalog = new CatalogDatabase(filename);
    assert.deepEqual(catalog.listFolderWatchPolicies(), expected);
    catalog.clearFolderWatchPolicy(root.id);
    assert.deepEqual(catalog.listFolderWatchPolicies(), []);
    catalog.setFolderWatchPolicy(root.id, owner.id);
    catalog.deleteContentRoot(root.id, owner.id);
    assert.deepEqual(catalog.listFolderWatchPolicies(), []);
    assert.throws(() => catalog.setFolderWatchPolicy(root.id, owner.id), /Folder not found/);
  } finally {
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  }
});
