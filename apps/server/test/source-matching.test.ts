import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { libraryFixture } from './library-fixture.js';

test('owner matching uses in-root sidecars through plugins and preserves private paths', async () => {
  const f = await libraryFixture();
  try {
    const path = join(f.base, 'games');
    await mkdir(path);
    await writeFile(join(path, 'Game.j64'), Buffer.from([1, 2, 3, 4]));
    await writeFile(
      join(path, 'Game.json'),
      JSON.stringify({ title: 'Generated Game', publisher: 'Homebrew' }),
    );
    await writeFile(join(path, 'Game.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    await writeFile(join(path, 'Other.json'), JSON.stringify({ title: 'Wrong' }));
    const patch = Buffer.concat([
      Buffer.from('BPS1'),
      Buffer.from([0x84, 0x85, 0x80]),
      Buffer.alloc(12),
    ]);
    patch.writeUInt32LE(crc32(Buffer.from([1, 2, 3, 4])), patch.length - 12);
    patch.writeUInt32LE(crc32(patch.subarray(0, -4)), patch.length - 4);
    await writeFile(join(path, 'Fan translation.bps'), patch);
    const root = f.catalog.createContentRoot({
      path,
      label: 'Games',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/v1/roots/${root.id}/scan`,
          headers: f.auth,
        })
      ).statusCode,
      200,
    );
    const source = f.catalog.listSources(root.id).find((s) => s.displayName === 'Game.j64');
    assert.ok(source);
    const url = `/api/v1/sources/${source.id}/matches`;
    const response = await f.app.inject({
      method: 'POST',
      url,
      headers: f.auth,
      payload: { online: false, checksum: true },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().sourceId, source.id);
    assert.ok(!response.body.includes(path));
    assert.ok(
      response
        .json()
        .candidates.some(
          (c: { title: string; providerId: string }) =>
            c.title === 'Generated Game' && c.providerId === 'org.ecs.local',
        ),
    );
    assert.ok(
      response
        .json()
        .candidates.some(
          (c: { kind: string; confidence: string }) =>
            c.kind === 'patch' && c.confidence === 'checksum',
        ),
    );
    const art = response.json().candidates.find((c: { kind: string }) => c.kind === 'artwork');
    assert.ok(art);
    const preview = await f.app.inject({
      url: `${url}/${response.json().requestId}/artwork/${encodeURIComponent(art.id)}`,
      headers: f.auth,
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.headers['content-type'], 'image/png');
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url,
          remoteAddress: '8.8.8.8',
          payload: { online: false },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await f.app.inject({ method: 'POST', url, headers: f.auth, payload: { online: 'yes' } }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: f.auth,
          payload: { providerIds: ['unknown'] },
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.dispose();
  }
});

test('selected matches persist, revise safely, and retain original source files', async () => {
  const f = await libraryFixture();
  try {
    const path = join(f.base, 'saved-games');
    await mkdir(path);
    await writeFile(join(path, 'Game.j64'), Buffer.from([1, 2, 3, 4]));
    await writeFile(
      join(path, 'Game.json'),
      JSON.stringify({ title: 'Selected title', publisher: 'Homebrew' }),
    );
    const artBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    await writeFile(join(path, 'Game.png'), artBytes);
    const root = f.catalog.createContentRoot({
      path,
      label: 'Games',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(root.id).find((s) => s.displayName === 'Game.j64');
    assert.ok(source);
    const url = `/api/v1/sources/${source.id}/matches`;
    const found = await f.app.inject({
      method: 'POST',
      url,
      headers: f.auth,
      payload: { online: false },
    });
    const requestId = found.json().requestId;
    const metadata = found.json().candidates.find((c: { kind: string }) => c.kind === 'metadata');
    const art = found.json().candidates.find((c: { kind: string }) => c.kind === 'artwork');
    assert.ok(metadata && art);
    const save = async (candidateId: string, expectedRevision: number) =>
      f.app.inject({
        method: 'PUT',
        url: `${url}/selections`,
        headers: f.auth,
        payload: { requestId, candidateId, expectedRevision },
      });
    const saved = await save(metadata.id, 0);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().revision, 1);
    assert.equal(
      (await save(metadata.id, 0)).json().revision,
      1,
      'A lost save reply can be retried',
    );
    assert.equal(
      (await save(art.id, 0)).statusCode,
      409,
      'Stale saves must not replace current choices',
    );
    assert.equal((await save(art.id, 1)).statusCode, 200);
    const browse = await f.app.inject({
      url: `/api/v1/browse?libraryId=${f.library.id}&category=games&search=Selected`,
      headers: f.auth,
    });
    assert.equal(browse.json().items[0]?.name, 'Selected title');
    assert.equal(browse.json().items[0]?.source.name, 'Game.j64');
    assert.equal(browse.json().items[0]?.source.artworkAvailable, true);
    const { openServer } = await import('../src/index.js');
    await f.close();
    const reopened = await openServer({ dataDir: join(f.base, 'data') });
    try {
      const selections = await reopened.app.inject({ url: `${url}/selections`, headers: f.auth });
      assert.equal(selections.statusCode, 200, selections.body);
      assert.equal(selections.json().matches.length, 2);
      const bytes = await reopened.app.inject({
        url: `${url}/selections/artwork/content`,
        headers: f.auth,
      });
      assert.deepEqual(bytes.rawPayload, artBytes);
      const clear = await reopened.app.inject({
        method: 'DELETE',
        url: `${url}/selections/metadata`,
        headers: { ...f.auth, 'if-match': '"rev-2"' },
      });
      assert.equal(clear.statusCode, 200, clear.body);
      assert.equal(clear.json().revision, 3);
      assert.equal(reopened.catalog.getSource(source.id)?.displayName, 'Game.j64');
      assert.equal(reopened.catalog.getSource(source.id)?.title, undefined);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.dispose();
  }
});

test('saved cheats are disabled snapshots with inherited read restrictions and stale lookup protection', async () => {
  const f = await libraryFixture();
  try {
    const { readFile, rename } = await import('node:fs/promises');
    const { issueToken } = await import('@ecs/auth');
    const path = join(f.base, 'cheat-games');
    await mkdir(path);
    const original =
      'cheats = 1\ncheat0_desc = "Generated example"\ncheat0_code = "0000:0000"\ncheat0_enable = true\n';
    await writeFile(join(path, 'Game.j64'), Buffer.from([1, 2, 3, 4]));
    await writeFile(join(path, 'Game.cht'), original);
    await writeFile(join(path, 'Game.json'), JSON.stringify({ title: 'Changed game title' }));
    const root = f.catalog.createContentRoot({
      path,
      label: 'Games',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(root.id).find((file) => file.displayName === 'Game.j64');
    assert.ok(source);
    const url = `/api/v1/sources/${source.id}/matches`;
    const lookup = await f.app.inject({
      method: 'POST',
      url,
      headers: f.auth,
      payload: { online: false },
    });
    const candidate = lookup.json().candidates.find((c: { kind: string }) => c.kind === 'cheats');
    assert.ok(candidate, lookup.body);
    const save = await f.app.inject({
      method: 'PUT',
      url: `${url}/selections`,
      headers: f.auth,
      payload: {
        requestId: lookup.json().requestId,
        candidateId: candidate.id,
        expectedRevision: 0,
      },
    });
    assert.equal(save.statusCode, 200, save.body);
    const download = await f.app.inject({
      url: `${url}/selections/cheats/content`,
      headers: f.auth,
    });
    assert.equal(download.statusCode, 200);
    assert.match(download.body, /cheat0_enable = "false"/);
    assert.equal(await readFile(join(path, 'Game.cht'), 'utf8'), original);
    const guest = issueToken();
    f.catalog.createGuestGrant({
      libraryId: f.library.id,
      itemId: null,
      capabilities: ['read'],
      tokenHash: guest.hash,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      createdBy: f.owner.id,
    });
    const headers = { authorization: `Bearer ${guest.token}` };
    assert.equal(
      (await f.app.inject({ url: `${url}/selections/cheats/content`, headers })).statusCode,
      404,
    );
    assert.equal(
      (await f.app.inject({ url: `${url}/selections`, headers })).json().matches.length,
      0,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: `${url}/selections`,
          headers,
          payload: {
            requestId: lookup.json().requestId,
            candidateId: candidate.id,
            expectedRevision: 1,
          },
        })
      ).statusCode,
      403,
    );
    await writeFile(join(path, 'Game.j64'), Buffer.from([1, 2, 3, 4, 5]));
    const metadata = lookup.json().candidates.find((c: { kind: string }) => c.kind === 'metadata');
    assert.ok(metadata);
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: `${url}/selections`,
          headers: f.auth,
          payload: {
            requestId: lookup.json().requestId,
            candidateId: metadata.id,
            expectedRevision: 1,
          },
        })
      ).statusCode,
      409,
    );
    await rename(path, path + '-offline');
    assert.equal(
      (await f.app.inject({ url: `${url}/selections/cheats/content`, headers: f.auth })).statusCode,
      200,
    );
  } finally {
    await f.dispose();
  }
});
