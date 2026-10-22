import assert from 'node:assert/strict';
import fs, { link, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { libraryFixture } from './library-fixture.js';

const metadata = {
  id: 'saved',
  kind: 'metadata' as const,
  providerId: 'fixture',
  title: 'Saved title',
  confidence: 'name' as const,
  originKind: null,
  contentAvailable: false,
  contentType: null,
  fileName: null,
  updatedAt: '',
  metadata: {},
};

for (const oldFirst of [false, true])
  for (const unassigned of [false, true]) {
    test(`passive cross-root move preserves saved state (${oldFirst ? 'old' : 'target'} first, ${unassigned ? 'unassigned' : 'library'})`, async () => {
      const f = await libraryFixture();
      try {
        const roots = await Promise.all(
          ['old', 'target'].map(async (name) => {
            const path = join(f.base, name);
            await mkdir(path);
            return f.catalog.createContentRoot({
              path,
              label: name,
              libraryId: unassigned ? null : f.library.id,
              actorId: f.owner.id,
            });
          }),
        );
        const old = roots[0];
        assert.ok(old);
        const target = roots[1];
        assert.ok(target);
        const scan = async (id: string) => {
          const response = await f.app.inject({
            method: 'POST',
            url: `/api/v1/roots/${id}/scan`,
            headers: f.auth,
          });
          assert.equal(response.statusCode, 200, response.body);
        };
        await writeFile(join(old.path, 'before.nes'), 'generated');
        await scan(old.id);
        const source = f.catalog.listSources(old.id)[0];
        assert.ok(source);
        f.catalog.saveSourceMatch(source.id, 0, 'metadata', metadata, null, f.owner.id);
        const art = {
          ...metadata,
          id: 'art',
          kind: 'artwork' as const,
          contentAvailable: true,
          contentType: 'image/png',
        };
        const saved = f.catalog.saveSourceMatch(
          source.id,
          1,
          'artwork',
          art,
          Buffer.from('generated artwork'),
          f.owner.id,
        );
        await rename(join(old.path, 'before.nes'), join(target.path, 'after.nes'));
        if (oldFirst) {
          await scan(old.id);
          assert.equal(f.catalog.getSource(source.id), null);
          assert.deepEqual(f.catalog.listSources(old.id), []);
          assert.equal(
            f.catalog.listContentRootSummaries({ actor: f.actor }).find((r) => r.id === old.id)
              ?.indexedFileCount,
            0,
          );
          assert.equal(
            f.catalog.browseLibrary({
              actor: f.actor,
              libraryId: unassigned ? null : f.library.id,
              category: 'games',
              sort: 'name_asc',
              limit: 20,
            }).items.length,
            0,
          );
        }
        await scan(target.id);
        await scan(old.id);
        assert.equal(f.catalog.listSources(target.id)[0]?.id, source.id);
        assert.deepEqual(f.catalog.sourceMatches(source.id), saved);
        assert.deepEqual(
          f.catalog.sourceMatchContent(source.id, 'artwork'),
          new Uint8Array(Buffer.from('generated artwork')),
        );
        assert.equal(f.catalog.getSource(source.id)?.relativePath, 'after.nes');
        assert.equal(f.catalog.getSource(source.id)?.rootId, target.id);
      } finally {
        await f.dispose();
      }
    });
  }

for (const reason of ['replacement', 'other-library', 'offline', 'hardlink'] as const) {
  test(`cross-root move rejects ${reason}`, async () => {
    const f = await libraryFixture();
    try {
      const oldPath = join(f.base, 'old');
      const targetPath = join(f.base, 'target');
      await mkdir(oldPath);
      await mkdir(targetPath);
      const old = f.catalog.createContentRoot({
        path: oldPath,
        label: 'old',
        libraryId: f.library.id,
        actorId: f.owner.id,
      });
      const target = f.catalog.createContentRoot({
        path: targetPath,
        label: 'target',
        libraryId:
          reason === 'other-library'
            ? f.catalog.createLibrary(f.owner.id, 'Other').id
            : f.library.id,
        actorId: f.owner.id,
      });
      const scan = async (id: string) => {
        const response = await f.app.inject({
          method: 'POST',
          url: `/api/v1/roots/${id}/scan`,
          headers: f.auth,
        });
        assert.equal(response.statusCode, 200, response.body);
      };
      await writeFile(join(oldPath, 'before.nes'), 'generated');
      await scan(old.id);
      const source = f.catalog.listSources(old.id)[0];
      assert.ok(source);
      f.catalog.saveSourceMatch(source.id, 0, 'metadata', metadata, null, f.owner.id);
      await rename(join(oldPath, 'before.nes'), join(targetPath, 'after.nes'));
      if (reason === 'replacement') await writeFile(join(oldPath, 'before.nes'), 'replacement');
      if (reason === 'offline') await rename(oldPath, `${oldPath}-unmounted`);
      if (reason === 'hardlink')
        await link(join(targetPath, 'after.nes'), join(f.base, 'unregistered-link.nes'));
      await scan(target.id);
      const result = f.catalog.listSources(target.id)[0];
      assert.ok(result);
      assert.notEqual(result.id, source.id);
      assert.equal(f.catalog.sourceMatches(result.id).revision, 0);
    } finally {
      await f.dispose();
    }
  });
}

test('scans reserve every same-library root, including missing candidates, and protect root mutation', async () => {
  const f = await libraryFixture();
  const { reserveContentRoots } = await import('../src/root-mutations.js');
  try {
    const old = f.catalog.createContentRoot({
      path: join(f.base, 'old'),
      label: 'Old',
      libraryId: null,
      actorId: f.owner.id,
    });
    const target = f.catalog.createContentRoot({
      path: join(f.base, 'target'),
      label: 'Target',
      libraryId: null,
      actorId: f.owner.id,
    });
    const release = reserveContentRoots(f.catalog, [old.id]);
    try {
      for (const request of [
        { method: 'POST' as const, url: `/api/v1/roots/${target.id}/scan` },
        { method: 'DELETE' as const, url: `/api/v1/roots/${old.id}` },
        {
          method: 'PUT' as const,
          url: `/api/v1/roots/${old.id}/library`,
          payload: { libraryId: f.library.id },
        },
      ])
        assert.equal((await f.app.inject({ ...request, headers: f.auth })).statusCode, 409);
    } finally {
      release();
    }
    assert.equal(f.catalog.getContentRoot(old.id)?.libraryId, null);
  } finally {
    await f.dispose();
  }
});

test('a rename during traversal cannot create duplicate identities or discard saved matches', async (t) => {
  const f = await libraryFixture();
  const { scanRoot } = await import('../src/source-scan.js');
  try {
    const path = join(f.base, 'racing');
    await mkdir(join(path, 'z-nested'), { recursive: true });
    const before = join(path, 'a-before.nes');
    const after = join(path, 'z-nested', 'after.nes');
    await writeFile(before, 'generated bytes');
    const root = f.catalog.createContentRoot({
      path,
      label: 'Racing fixture',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await scanRoot(f.catalog, root, f.owner.id);
    const source = f.catalog.listSources(root.id)[0];
    assert.ok(source);
    const saved = f.catalog.saveSourceMatch(source.id, 0, 'metadata', metadata, null, f.owner.id);
    const stat = fs.stat;
    let moved = false;
    t.mock.method(fs, 'stat', async (...args: Parameters<typeof stat>) => {
      const facts = await stat(...args);
      if (!moved && args[0] === before) {
        moved = true;
        // The scanner already captured the old name; its next directory contains
        // the very same file under the new name. No hard links were created.
        await rename(before, after);
      }
      return facts;
    });
    syncBuiltinESMExports();
    await scanRoot(f.catalog, root, f.owner.id);
    assert.equal(moved, true);
    assert.equal(f.catalog.listSources(root.id).length, 1);
    assert.equal(f.catalog.listSources(root.id)[0]?.id, source.id);
    assert.equal(f.catalog.getSource(source.id)?.relativePath, 'z-nested/after.nes');
    assert.deepEqual(f.catalog.sourceMatches(source.id), saved);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.dispose();
  }
});

test('duplicate-identity revalidation keeps real hard links distinct and saved matches on the original', async () => {
  const f = await libraryFixture();
  const { scanRoot } = await import('../src/source-scan.js');
  try {
    const path = join(f.base, 'real-hardlinks');
    await mkdir(path);
    await writeFile(join(path, 'original.nes'), 'generated bytes');
    const root = f.catalog.createContentRoot({
      path,
      label: 'Hard links',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await scanRoot(f.catalog, root, f.owner.id);
    const original = f.catalog.listSources(root.id)[0];
    assert.ok(original);
    const saved = f.catalog.saveSourceMatch(original.id, 0, 'metadata', metadata, null, f.owner.id);
    await link(join(path, 'original.nes'), join(path, 'another-name.nes'));
    await scanRoot(f.catalog, root, f.owner.id);
    const sources = f.catalog.listSources(root.id);
    assert.equal(sources.length, 2);
    assert.equal(f.catalog.getSource(original.id)?.relativePath, 'original.nes');
    assert.deepEqual(f.catalog.sourceMatches(original.id), saved);
    const linked = sources.find((source) => source.relativePath === 'another-name.nes');
    assert.ok(linked);
    assert.notEqual(linked.id, original.id);
    assert.equal(f.catalog.sourceMatches(linked.id).revision, 0);
  } finally {
    await f.dispose();
  }
});

test('a registered folder replaced with a symlink cannot redirect background scans', async () => {
  const f = await libraryFixture();
  const { scanRoot } = await import('../src/source-scan.js');
  try {
    const path = join(f.base, 'registered');
    const outside = join(f.base, 'unregistered');
    await mkdir(path);
    await mkdir(outside);
    await writeFile(join(path, 'original.nes'), 'generated original');
    await writeFile(join(outside, 'private.nes'), 'generated outside');
    const root = f.catalog.createContentRoot({
      path,
      label: 'Registered',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await scanRoot(f.catalog, root, f.owner.id);
    const original = f.catalog.listSources(root.id)[0];
    assert.ok(original);
    await rename(path, `${path}-held`);
    await symlink(outside, path, 'dir');
    await assert.rejects(scanRoot(f.catalog, root, f.owner.id), /Registered folder has changed/);
    assert.deepEqual(
      f.catalog.listSources(root.id).map((file) => file.id),
      [original.id],
    );
  } finally {
    await f.dispose();
  }
});

test('replacing a root after its initial canonical check cannot index an unregistered tree', async (t) => {
  const f = await libraryFixture();
  const { scanRoot } = await import('../src/source-scan.js');
  try {
    const path = join(f.base, 'racing-root');
    const outside = join(f.base, 'outside-root');
    await mkdir(path);
    await mkdir(outside);
    await writeFile(join(path, 'original.nes'), 'generated original');
    await writeFile(join(outside, 'private.nes'), 'generated outside');
    const root = f.catalog.createContentRoot({
      path,
      label: 'Pinned',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await scanRoot(f.catalog, root, f.owner.id);
    const original = f.catalog.listSources(root.id)[0];
    assert.ok(original);
    const realpath = fs.realpath;
    let replaced = false;
    t.mock.method(fs, 'realpath', async (...args: Parameters<typeof realpath>) => {
      const resolved = await realpath(...args);
      if (!replaced && args[0] === path) {
        replaced = true;
        await rename(path, `${path}-held`);
        await symlink(outside, path, 'dir');
      }
      return resolved;
    });
    syncBuiltinESMExports();
    await assert.rejects(scanRoot(f.catalog, root, f.owner.id), /Registered folder has changed/);
    assert.equal(replaced, true);
    assert.deepEqual(
      f.catalog.listSources(root.id).map((file) => file.id),
      [original.id],
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.dispose();
  }
});
