import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { libraryFixture } from './library-fixture.js';

test('links folder copies into one game and negotiates a readable compatible representation', async () => {
  const f = await libraryFixture();
  try {
    const systemId = 'com.provenance.dreamcast';
    async function index(folder: string, filename: string) {
      const path = join(f.base, folder, 'Dreamcast');
      await mkdir(path, { recursive: true });
      await writeFile(join(path, filename), 'generated disc');
      const root = f.catalog.createContentRoot({
        path,
        label: folder,
        libraryId: f.library.id,
        actorId: f.owner.id,
      });
      const scan = await f.app.inject({
        method: 'POST',
        url: `/api/v1/roots/${root.id}/scan`,
        headers: f.auth,
      });
      assert.equal(scan.statusCode, 200, scan.body);
      const [source] = f.catalog.listSources(root.id);
      assert.ok(source);
      return { source, path };
    }
    const local = await index('local', 'Game.chd');
    const remote = await index('Library/CloudStorage/fixture', 'Game.cdi');
    async function link(sourceId: string, payload: { itemId?: string | null; title?: string }) {
      const response = await f.app.inject({
        method: 'PUT',
        url: `/api/v1/sources/${sourceId}/game`,
        headers: f.auth,
        payload,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<{ itemId: string }>().itemId;
    }
    const id = await link(local.source.id, { title: 'One game' });
    assert.equal(await link(local.source.id, { title: 'One game' }), id);
    await link(remote.source.id, { itemId: id });
    const browse = await f.app.inject({
      method: 'GET',
      url: `/api/v1/browse?libraryId=${f.library.id}&category=games`,
      headers: f.auth,
    });
    assert.equal(browse.statusCode, 200, browse.body);
    assert.deepEqual(
      browse.json().items.map((item: { id: string }) => item.id),
      [id],
    );
    const searched = await f.app.inject({
      method: 'GET',
      url: `/api/v1/browse?libraryId=${f.library.id}&category=games&search=Game.cdi`,
      headers: f.auth,
    });
    assert.equal(searched.statusCode, 200, searched.body);
    assert.deepEqual(
      searched.json().items.map((item: { id: string }) => item.id),
      [id],
    );
    async function select(formats: string[], headers = f.auth) {
      const response = await f.app.inject({
        method: 'POST',
        url: `/api/v1/items/${id}/rom-selection`,
        headers,
        payload: { systems: [{ systemId, formats }] },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json().copy ?? null;
    }
    assert.equal((await select(['cdi', 'chd'])).id, local.source.id);
    assert.equal((await select(['cdi'])).id, remote.source.id);
    assert.equal(await select(['zip']), null);
    await rename(local.path, `${local.path}-offline`);
    assert.equal((await select(['chd', 'cdi'])).id, remote.source.id);

    const guest = issueToken();
    f.catalog.createGuestGrant({
      libraryId: f.library.id,
      itemId: id,
      tokenHash: guest.hash,
      capabilities: ['read'],
      expiresAt: '2099-01-01T00:00:00Z',
      createdBy: f.owner.id,
    });
    assert.equal(await select(['cdi'], { authorization: `Bearer ${guest.token}` }), null);

    const olderBrowse = await f.app.inject({
      method: 'GET',
      url: `/api/v1/browse?libraryId=${f.library.id}&category=games&rootId=${remote.source.rootId}`,
      headers: f.auth,
    });
    assert.equal(olderBrowse.statusCode, 200, olderBrowse.body);
    assert.equal(olderBrowse.json().items[0].id, remote.source.id);
    await link(remote.source.id, { itemId: null });
    assert.equal(await select(['cdi']), null);
  } finally {
    await f.dispose();
  }
});
