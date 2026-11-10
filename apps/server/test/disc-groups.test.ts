import assert from 'node:assert/strict';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
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

test('NAOMI ZIP and CHD stay one game with Flycast paths and recover after a missing disc returns', async () => {
  for (const name of ['Naomi', 'Naomi 2']) {
    const f = await libraryFixture();
    try {
      const path = join(f.base, 'arcade');
      const directory = join(path, name, 'cart');
      await mkdir(directory, { recursive: true });
      const zipPath = join(path, name, 'cart.zip');
      const chdPath = join(directory, 'gdrom.chd');
      const generated = Buffer.from('generated GD-ROM bytes');
      await writeFile(zipPath, 'generated ZIP bytes');
      await writeFile(chdPath, generated);
      const root = f.catalog.createContentRoot({
        path,
        label: 'Arcade',
        libraryId: f.library.id,
        actorId: f.owner.id,
      });
      const scan = async () => {
        const response = await f.app.inject({
          method: 'POST',
          url: `/api/v1/roots/${root.id}/scan`,
          headers: f.auth,
        });
        assert.equal(response.statusCode, 200, response.body);
      };
      await scan();
      const source = f.catalog.listSources(root.id).find((file) => file.displayName === 'cart.zip');
      assert.ok(source);
      const browseUrl = `/api/v1/browse?libraryId=${f.library.id}&category=games`;
      const browse = await f.app.inject({ url: browseUrl, headers: f.auth });
      assert.equal(browse.json().items.length, 1);
      assert.equal(browse.json().items[0].source.id, source.id);
      assert.equal(browse.json().items[0].source.groupFileCount, 2);
      assert.equal(browse.json().items[0].source.groupError, null);
      const groupUrl = `/api/v1/sources/${source.id}/group`;
      const group = await f.app.inject({ url: groupUrl, headers: f.auth });
      assert.equal(group.statusCode, 200, group.body);
      assert.equal(group.json().error, null);
      assert.deepEqual(
        group.json().files.map((file: { relativePath: string }) => file.relativePath),
        ['cart.zip', 'cart/gdrom.chd'],
      );
      const discId = group.json().files[1].id;
      const content = await f.app.inject({
        url: `/api/v1/sources/${discId}/content`,
        headers: f.auth,
      });
      assert.equal(content.statusCode, 200);
      assert.deepEqual(content.rawPayload, generated);
      const bundled = await f.app.inject({
        url: `/api/v1/sources/${source.id}/bundle`,
        headers: f.auth,
      });
      assert.equal(bundled.statusCode, 200, bundled.body);
      const archive = join(f.base, 'generated.zip');
      await writeFile(archive, bundled.rawPayload);
      const inspected = await new ZipProvider().inspect(archive, DEFAULT_MATERIALIZE_QUOTA);
      assert.deepEqual(inspected?.entries.map((entry) => entry.path).sort(), [
        `${name}/cart.zip`,
        `${name}/cart/gdrom.chd`,
      ]);

      const disconnected = join(f.base, 'disconnected.chd');
      await rename(chdPath, disconnected);
      const unavailable = await f.app.inject({
        url: `/api/v1/sources/${source.id}/bundle`,
        headers: f.auth,
      });
      assert.ok([409, 503].includes(unavailable.statusCode), unavailable.body);
      await scan();
      const missing = await f.app.inject({ url: groupUrl, headers: f.auth });
      assert.match(missing.json().error, /missing/i);
      const missingBrowse = await f.app.inject({ url: browseUrl, headers: f.auth });
      assert.equal(missingBrowse.json().items.length, 1);
      assert.equal(missingBrowse.json().items[0].source.groupFileCount, 2);
      assert.match(missingBrowse.json().items[0].source.groupError, /missing/i);
      await rename(disconnected, chdPath);
      await scan();
      const restored = await f.app.inject({ url: groupUrl, headers: f.auth });
      assert.equal(restored.json().error, null);
      assert.equal(restored.json().files[1].id, discId);
      await rm(zipPath);
      await scan();
      const orphaned = await f.app.inject({ url: browseUrl, headers: f.auth });
      assert.equal(orphaned.json().items.length, 1);
      assert.match(orphaned.json().items[0].source.groupError, /missing/i);
      await scan();
      const stillOrphaned = await f.app.inject({ url: browseUrl, headers: f.auth });
      assert.match(stillOrphaned.json().items[0].source.groupError, /missing/i);
    } finally {
      await f.dispose();
    }
  }
});

test('uploaded NAOMI item manifests preserve required ZIP and CHD relative paths', async () => {
  const f = await libraryFixture();
  try {
    const item = f.catalog.createItem({
      libraryId: f.library.id,
      title: 'Generated arcade game',
      systemIdentifier: 'com.provenance.naomi',
      md5: null,
      crc: null,
      actorId: f.owner.id,
    });
    for (const [index, relativePath] of ['cart.zip', 'cart/gdrom.chd'].entries()) {
      f.catalog.completeUpload({
        uploadId: f.catalog.createUpload({
          userId: f.owner.id,
          guestGrantId: null,
          libraryId: f.library.id,
        }).id,
        itemId: item.id,
        kind: 'rom',
        displayName: relativePath.split('/').at(-1) ?? relativePath,
        relativePath,
        baseRevision: f.catalog.getItem(item.id)?.revision ?? 1,
        sha256: String(index + 1).repeat(64),
        size: 8,
        md5: String(index + 1).repeat(32),
        crc: String(index + 1).repeat(8),
        shareable: true,
        actorId: f.owner.id,
        locationId: null,
      });
    }
    const manifest = await f.app.inject({
      url: `/api/v1/items/${item.id}/manifest`,
      headers: f.auth,
    });
    assert.equal(manifest.statusCode, 200, manifest.body);
    assert.deepEqual(
      manifest
        .json()
        .files.map((file: { relativePath: string }) => file.relativePath)
        .sort(),
      ['cart.zip', 'cart/gdrom.chd'],
    );
    assert.ok(
      manifest
        .json()
        .files.every(
          (file: { kind: string; required: boolean }) => file.kind === 'rom' && file.required,
        ),
    );
  } finally {
    await f.dispose();
  }
});
