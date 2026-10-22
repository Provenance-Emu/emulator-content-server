import assert from 'node:assert/strict';
import { link, mkdir, rename, writeFile } from 'node:fs/promises';
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
