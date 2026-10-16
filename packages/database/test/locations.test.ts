import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DomainError } from '@ecs/domain';
import { CatalogDatabase } from '../src/index.js';

const DIGEST = 'a'.repeat(64);

function conflict(message: string) {
  return (error: unknown) =>
    error instanceof DomainError && error.code === 'conflict' && error.message === message;
}

test('a location keeps the first copy of a digest and cannot be removed while it is referenced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-locations-'));
  const catalog = new CatalogDatabase(join(dir, 'library.sqlite'));
  try {
    catalog.ensureServer('Living Room');
    assert.equal(catalog.writeLocation(), null);
    const user = catalog.createUser({
      username: 'owner',
      passwordHash: 'not-a-password-hash',
      actorId: 'test',
    });
    const library = catalog.createLibrary(user.id, 'Library');
    const item = catalog.createItem({
      libraryId: library.id,
      systemIdentifier: 'com.provenance.nes',
      title: 'Example',
      md5: null,
      crc: null,
      actorId: user.id,
    });
    const extra = catalog.createStorageLocation({
      path: '/mnt/extra',
      label: 'Extra',
      actorId: user.id,
    });
    const other = catalog.createStorageLocation({
      path: '/mnt/other',
      label: 'Other',
      actorId: user.id,
    });
    catalog.setWriteLocation(extra.id, user.id);
    assert.equal(catalog.writeLocation()?.label, 'Extra');
    assert.throws(
      () => catalog.deleteStorageLocation(extra.id, user.id),
      conflict('That location is where new bytes are written'),
    );

    const upload = catalog.createUpload({
      userId: user.id,
      guestGrantId: null,
      libraryId: library.id,
    });
    catalog.completeUpload({
      uploadId: upload.id,
      itemId: item.id,
      kind: 'rom',
      displayName: 'a.nes',
      relativePath: 'a.nes',
      baseRevision: item.revision,
      sha256: DIGEST,
      size: 4,
      md5: 'b'.repeat(32),
      crc: 'cccccccc',
      shareable: true,
      actorId: user.id,
      locationId: extra.id,
    });
    assert.equal(catalog.blobRecord(DIGEST)?.locationId, extra.id);

    const again = catalog.createUpload({
      userId: user.id,
      guestGrantId: null,
      libraryId: library.id,
    });
    catalog.completeUpload({
      uploadId: again.id,
      itemId: item.id,
      kind: 'rom',
      displayName: 'b.nes',
      relativePath: 'b.nes',
      baseRevision: item.revision + 1,
      sha256: DIGEST,
      size: 4,
      md5: 'b'.repeat(32),
      crc: 'cccccccc',
      shareable: true,
      actorId: user.id,
      locationId: other.id,
    });
    assert.equal(
      catalog.blobRecord(DIGEST)?.locationId,
      extra.id,
      'the same bytes stay in the location that first stored them',
    );

    catalog.setWriteLocation(null, user.id);
    assert.throws(
      () => catalog.deleteStorageLocation(extra.id, user.id),
      conflict('That location still holds blobs'),
    );
    catalog.deleteStorageLocation(other.id, user.id);
    assert.equal(
      catalog.listStorageLocations().some((location) => location.id === other.id),
      false,
    );
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});
