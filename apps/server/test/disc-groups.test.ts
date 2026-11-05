import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { DEFAULT_MATERIALIZE_QUOTA, ZipProvider } from '@ecs/storage';
import { libraryFixture } from './library-fixture.js';

test('a grouped game exposes individual files and a complete authorized streaming ZIP', async () => {
  const f = await libraryFixture();
  try {
    const path = join(f.base, 'discs');
    await mkdir(path);
    const cue = 'FILE "Track.bin" BINARY\n';
    await writeFile(join(path, 'Game.cue'), cue);
    await writeFile(join(path, 'Track.bin'), Buffer.from([1, 2, 3]));
    const root = f.catalog.createContentRoot({
      path,
      label: 'Discs',
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
    const browse = await f.app.inject({
      url: `/api/v1/browse?libraryId=${f.library.id}&category=games`,
      headers: f.auth,
    });
    assert.equal(browse.json().items.length, 1);
    const source = browse.json().items[0].source;
    assert.equal(source.groupFileCount, 2);
    const groupUrl = `/api/v1/sources/${source.id}/group`;
    const group = await f.app.inject({ url: groupUrl, headers: f.auth });
    assert.equal(group.statusCode, 200, group.body);
    assert.equal(group.json().files.length, 2);
    assert.deepEqual(
      group
        .json()
        .files.map((file: { relativePath: string }) => file.relativePath)
        .sort(),
      ['Game.cue', 'Track.bin'],
    );
    assert.equal(group.body.includes(path), false);
    const member = group.json().files.find((file: { name: string }) => file.name === 'Track.bin');
    const single = await f.app.inject({
      url: `/api/v1/sources/${member.id}/content`,
      headers: f.auth,
    });
    assert.deepEqual(single.rawPayload, Buffer.from([1, 2, 3]));
    const zip = await f.app.inject({ url: `/api/v1/sources/${source.id}/bundle`, headers: f.auth });
    assert.equal(zip.statusCode, 200, zip.body);
    assert.match(String(zip.headers['content-disposition']), /attachment/);
    const archive = join(f.base, 'generated.zip');
    await writeFile(archive, zip.rawPayload);
    const inspected = await new ZipProvider().inspect(archive, DEFAULT_MATERIALIZE_QUOTA);
    assert.deepEqual(inspected?.entries.map((e) => e.path).sort(), ['Game.cue', 'Track.bin']);
    assert.equal((await f.app.inject({ url: groupUrl, remoteAddress: '8.8.8.8' })).statusCode, 401);
    const token = issueToken();
    f.catalog.createGuestGrant({
      libraryId: f.library.id,
      itemId: null,
      capabilities: ['write'],
      tokenHash: token.hash,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      createdBy: f.owner.id,
    });
    assert.equal(
      (await f.app.inject({ url: groupUrl, headers: { authorization: `Bearer ${token.token}` } }))
        .statusCode,
      403,
    );
    await writeFile(join(path, 'Game.cue'), 'FILE "../outside.bin" BINARY\n');
    assert.equal(
      (await f.app.inject({ url: `/api/v1/sources/${source.id}/bundle`, headers: f.auth }))
        .statusCode,
      409,
    );
  } finally {
    await f.dispose();
  }
});

test('disc staging paths share a contained common directory and omit unrelated source folders', async () => {
  const f = await libraryFixture();
  try {
    const path = join(f.base, 'group');
    await mkdir(join(path, 'private-parent', 'disc'), { recursive: true });
    await mkdir(join(path, 'private-parent', 'tracks'));
    await writeFile(
      join(path, 'private-parent', 'disc', 'Game.cue'),
      'FILE "../tracks/track.bin" BINARY\nTRACK 01 AUDIO\n',
    );
    await writeFile(join(path, 'private-parent', 'tracks', 'track.bin'), Buffer.from([1, 2, 3]));
    const root = f.catalog.createContentRoot({
      path,
      label: 'Generated',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    const cue = f.catalog.listSources(root.id).find((file) => file.relativePath.endsWith('.cue'));
    assert.ok(cue);
    const group = await f.app.inject({ url: `/api/v1/sources/${cue.id}/group`, headers: f.auth });
    assert.equal(group.statusCode, 200, group.body);
    assert.deepEqual(
      group
        .json()
        .files.map((file: { relativePath: string }) => file.relativePath)
        .sort(),
      ['disc/Game.cue', 'tracks/track.bin'],
    );
    assert.ok(!group.body.includes('private-parent'));
  } finally {
    await f.dispose();
  }
});
