import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DomainError } from '@ecs/domain';
import {
  ensureBlobStore,
  ensureLayout,
  locationOnline,
  resolveStorageLocation,
} from '../src/index.js';

function rejected(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

test('a storage location is a real directory outside the data directory and every content root', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-location-')));
  const dataDir = join(base, 'content-data');
  const extra = join(base, 'extra');
  const collection = join(base, 'collection');
  try {
    await ensureLayout(dataDir);
    await mkdir(extra);
    await mkdir(collection);
    assert.equal(await locationOnline(extra), false);
    await ensureBlobStore(extra);
    assert.equal(await locationOnline(extra), true);

    const link = join(base, 'link-to-extra');
    await symlink(extra, link);
    assert.equal(await resolveStorageLocation(dataDir, link, [], []), extra);

    await assert.rejects(
      resolveStorageLocation(dataDir, 'extra', []),
      rejected('invalid-location'),
    );
    await assert.rejects(
      resolveStorageLocation(dataDir, join(dataDir, 'blobs'), []),
      rejected('invalid-location'),
    );
    const notes = join(base, 'notes.txt');
    await writeFile(notes, 'notes');
    await assert.rejects(resolveStorageLocation(dataDir, notes, []), rejected('invalid-location'));
    assert.equal(await resolveStorageLocation(dataDir, extra, [], [collection]), extra);
    await assert.rejects(resolveStorageLocation(dataDir, extra, [extra]), rejected('conflict'));
    await assert.rejects(resolveStorageLocation(dataDir, extra, [], [extra]), rejected('conflict'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
