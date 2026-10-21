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
