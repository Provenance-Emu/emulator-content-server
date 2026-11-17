import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CatalogDatabase } from '@ecs/database';
import { blobPath } from '@ecs/storage';
import { backupData, copyNewerBlobs, initData } from '../src/lifecycle.js';

const cli = fileURLToPath(new URL('../src/main.js', import.meta.url));

test('locations are registered, chosen as the write target, and backed up only while online', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-cli-locations-')));
  const dataDir = join(base, 'content-data');
  const extra = join(base, 'extra');
  const destination = join(base, 'backup');
  try {
    await mkdir(extra);
    assert.equal(run(['init', '--data', dataDir]).status, 0);
    const added = run(['locations', 'add', '--data', dataDir, '--path', extra, '--label', 'Extra']);
    assert.equal(added.status, 0, added.stderr);
    const listed = run(['locations', 'list', '--data', dataDir]);
    assert.match(listed.stdout, /write primary/);
    assert.match(listed.stdout, new RegExp(`Extra {2}${escapeRegExp(extra)}`));
    const id = listed.stdout
      .trim()
      .split('\n')
      .find((line) => line.includes('Extra'))
      ?.split(/\s+/)[0];
    assert.ok(id);

    const inside = run([
      'locations',
      'add',
      '--data',
      dataDir,
      '--path',
      join(dataDir, 'blobs'),
      '--label',
      'Inside',
    ]);
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /data directory/);

    const chosen = run(['locations', 'use', '--data', dataDir, '--id', id]);
    assert.equal(chosen.status, 0, chosen.stderr);
    assert.match(run(['locations', 'list', '--data', dataDir]).stdout, new RegExp(`${id}.*write`));
    const held = run(['locations', 'remove', '--data', dataDir, '--id', id]);
    assert.equal(held.status, 1);
    assert.match(held.stderr, /new bytes are written/);

    assert.equal(run(['locations', 'use', '--data', dataDir, '--primary']).status, 0);
    await rm(extra, { recursive: true, force: true });
    const report = run(['doctor', '--data', dataDir]);
    assert.equal(report.status, 1);
    assert.match(report.stdout, /integrity ok/);
    assert.match(report.stdout, /offline location Extra/);
    const refused = run(['backup', '--data', dataDir, '--to', destination]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Extra/);
    assert.match(refused.stderr, /offline/);
    await assert.rejects(stat(destination));

    await mkdir(join(extra, 'blobs', 'sha256'), { recursive: true });
    await writeFile(join(extra, 'blobs', 'sha256', 'marker'), 'kept');
    await backupData(dataDir, destination);
    assert.equal(
      await readFile(join(destination, 'locations', id, 'blobs', 'sha256', 'marker'), 'utf8'),
      'kept',
    );
    const manifest = JSON.parse(await readFile(join(destination, 'locations.json'), 'utf8')) as {
      label: string;
    }[];
    assert.equal(manifest[0]?.label, 'Extra');
    await stat(join(destination, 'library.sqlite'));
    await stat(join(destination, 'blobs'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('a backup holds the bytes of every file its catalog names, including the trash', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ecs-backup-trash-'));
  const dataDir = join(base, 'data');
  const destination = join(base, 'backup');
  try {
    await initData(dataDir, 'Test');
    const catalog = new CatalogDatabase(join(dataDir, 'library.sqlite'));
    const digests: string[] = [];
    try {
      const user = catalog.createUser({ username: 'owner', passwordHash: 'x', actorId: 'test' });
      const library = catalog.createLibrary(user.id, 'Library');
      const item = catalog.createItem({
        libraryId: library.id,
        systemIdentifier: 'com.provenance.nes',
        title: 'Example',
        md5: null,
        crc: null,
        actorId: user.id,
      });
      for (const name of ['live.generated', 'trashed.generated']) {
        const bytes = randomBytes(32);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        digests.push(sha256);
        await mkdir(dirname(blobPath(dataDir, sha256)), { recursive: true });
        await writeFile(blobPath(dataDir, sha256), bytes);
        const asset = catalog.completeUpload({
          uploadId: catalog.createUpload({
            userId: user.id,
            guestGrantId: null,
            libraryId: library.id,
          }).id,
          itemId: item.id,
          kind: 'rom',
          displayName: name,
          relativePath: name,
          baseRevision: catalog.getItem(item.id)?.revision ?? 1,
          sha256,
          size: bytes.length,
          md5: 'b'.repeat(32),
          crc: '12345678',
          shareable: true,
          actorId: user.id,
          locationId: null,
        });
        if (name.startsWith('trashed')) catalog.deleteAsset(asset.id, user.id);
      }
    } finally {
      catalog.close();
    }
    await backupData(dataDir, destination);
    for (const sha256 of digests) await stat(blobPath(destination, sha256));

    // An upload that lands between the byte copy and the catalog snapshot is
    // named by the snapshot but missed by the copy. The top-up fetches it.
    const late = digests[0] as string;
    await rm(blobPath(destination, late));
    assert.equal(await copyNewerBlobs(dataDir, destination, []), 1);
    assert.deepEqual(
      await readFile(blobPath(destination, late)),
      await readFile(blobPath(dataDir, late)),
    );
    assert.equal(await copyNewerBlobs(dataDir, destination, []), 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
