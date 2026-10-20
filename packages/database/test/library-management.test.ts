import assert from 'node:assert/strict';
import test from 'node:test';
import { type Actor, DomainError } from '@ecs/domain';
import { CatalogDatabase } from '../src/index.js';

const code = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;
function fixture() {
  const db = new CatalogDatabase(':memory:');
  const owner = db.createUser({ username: 'owner', passwordHash: 'fixture', actorId: 'test' });
  const actor: Actor = {
    kind: 'user',
    userId: owner.id,
    username: 'owner',
    isOwner: true,
    tokenKind: 'session',
    deviceId: null,
    scopes: ['read'],
  };
  const library = db.createLibrary(owner.id, 'Library');
  return { db, actor, owner, library };
}

test('renaming compares revisions atomically and records one audited change', () => {
  const f = fixture();
  try {
    const before = f.db.changes({
      after: 0,
      limit: 100,
      libraryIds: [f.library.id],
      includeSensitive: true,
      itemId: null,
    }).nextCursor;
    const input = {
      id: f.library.id,
      name: 'Renamed',
      baseRevision: 1,
      actorId: f.owner.id,
      deviceId: 'device',
    };
    const renamed = f.db.renameLibrary(input);
    assert.equal(renamed.name, 'Renamed');
    assert.equal(renamed.revision, 2);
    assert.throws(() => f.db.renameLibrary({ ...input, name: 'Stale' }), code('conflict'));
    assert.equal(f.db.getLibrary(f.library.id)?.name, 'Renamed');
    assert.equal(
      f.db.changes({
        after: before,
        limit: 100,
        libraryIds: [f.library.id],
        includeSensitive: true,
        itemId: null,
      }).changes.length,
      1,
    );
    assert.equal(f.db.auditContains('rename-library', 'Renamed'), true);
    assert.throws(() => f.db.renameLibrary({ ...input, id: 'missing' }), code('not-found'));
  } finally {
    f.db.close();
  }
});

test('assignment preserves source identities, is idempotent, and cannot move an assigned root', () => {
  const f = fixture();
  try {
    const root = f.db.createContentRoot({
      path: '/never/probed',
      label: 'Shelf',
      libraryId: null,
      actorId: f.owner.id,
    });
    f.db.applyInspection({
      rootId: root.id,
      actorId: f.owner.id,
      online: true,
      files: [
        {
          relativePath: 'generated',
          displayName: 'Generated',
          size: 1,
          blocks: 1,
          kind: 'rom',
          systemId: null,
          availability: 'local',
        },
      ],
    });
    const source = f.db.listSources(root.id)[0];
    const input = {
      rootId: root.id,
      libraryId: f.library.id,
      actorId: f.owner.id,
      deviceId: 'device',
    };
    const assigned = f.db.assignUnassignedRoot(input);
    assert.equal(assigned.libraryId, f.library.id);
    assert.equal(assigned.path, root.path);
    assert.deepEqual(f.db.listSources(root.id)[0], { ...source, libraryId: f.library.id });
    const before = f.db.changes({
      after: 0,
      limit: 100,
      libraryIds: [f.library.id],
      includeSensitive: true,
      itemId: null,
    }).nextCursor;
    assert.deepEqual(f.db.assignUnassignedRoot(input), assigned);
    assert.equal(
      f.db.changes({
        after: before,
        limit: 100,
        libraryIds: [f.library.id],
        includeSensitive: true,
        itemId: null,
      }).changes.length,
      0,
    );
    const other = f.db.createLibrary(f.owner.id, 'Other');
    assert.throws(
      () => f.db.assignUnassignedRoot({ ...input, libraryId: other.id }),
      code('conflict'),
    );
    assert.throws(
      () => f.db.assignUnassignedRoot({ ...input, libraryId: 'missing' }),
      code('not-found'),
    );
    assert.equal(f.db.auditContains('assign-content-root', f.library.id), true);
    f.db.deleteContentRoot(root.id, f.owner.id);
    assert.ok(
      f.db
        .changes({
          after: before,
          limit: 100,
          libraryIds: [f.library.id],
          includeSensitive: true,
          itemId: null,
        })
        .changes.some((change) => change.entityType === 'content-root' && change.op === 'delete'),
    );
  } finally {
    f.db.close();
  }
});

test('root summaries aggregate only authorized cached rows and record explicit checks and scans', () => {
  const f = fixture();
  try {
    const root = f.db.createContentRoot({
      path: '/never/probed',
      label: 'Shelf',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    f.db.createContentRoot({
      path: '/legacy',
      label: 'Legacy',
      libraryId: null,
      actorId: f.owner.id,
    });
    f.db.applyInspection({
      rootId: root.id,
      actorId: f.owner.id,
      online: true,
      files: ['rom', 'bios'].map((kind) => ({
        relativePath: kind,
        displayName: kind,
        size: 1,
        blocks: 1,
        kind,
        systemId: null,
        availability: 'local',
      })),
    });
    const initial = f.db.listContentRootSummaries({ actor: f.actor, libraryId: f.library.id })[0];
    assert.equal(initial?.indexedFileCount, 2);
    assert.equal(initial.scanState, 'unknown');
    assert.equal(initial.lastCheckedAt, null);
    f.db.recordRootCheck({
      rootId: root.id,
      availability: 'offline',
      medium: 'external',
      checkedAt: '2026-10-20T00:00:00.000Z',
    });
    f.db.beginRootScan(root.id);
    assert.equal(
      f.db.listContentRootSummaries({ actor: f.actor, libraryId: f.library.id })[0]?.scanState,
      'pending',
    );
    f.db.finishRootScan({ rootId: root.id, succeeded: false });
    const failed = f.db.listContentRootSummaries({ actor: f.actor, libraryId: f.library.id })[0];
    assert.equal(failed?.scanState, 'failed');
    assert.equal(failed.availability, 'offline');
    assert.ok(failed.lastScanCompletedAt);
    assert.ok(failed.scanError);
    f.db.beginRootScan(root.id);
    f.db.finishRootScan({ rootId: root.id, succeeded: true });
    const completed = f.db.listContentRootSummaries({ actor: f.actor, libraryId: f.library.id })[0];
    assert.equal(completed?.scanState, 'completed');
    assert.equal(completed.scanError, null);
    assert.equal(completed.medium, 'external');
    assert.equal(completed.lastCheckedAt, '2026-10-20T00:00:00.000Z');
    assert.equal(f.db.listContentRootSummaries({ actor: f.actor, libraryId: null }).length, 1);
    const guest: Actor = {
      kind: 'guest',
      grantId: 'fixture',
      libraryId: f.library.id,
      itemId: null,
      capabilities: ['read'],
    };
    assert.deepEqual(f.db.listContentRootSummaries({ actor: guest }), []); // Paths and root management remain owner-only.
    assert.deepEqual(f.db.listContentRootSummaries({ actor: { ...f.actor, isOwner: false } }), []);
  } finally {
    f.db.close();
  }
});

test('identical root checks update freshness without publishing a refresh event', () => {
  const f = fixture();
  try {
    const root = f.db.createContentRoot({
      path: '/not/probed',
      label: 'Shelf',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    const events = () =>
      f.db.changes({
        after: 0,
        limit: 100,
        libraryIds: [f.library.id],
        includeSensitive: true,
        itemId: null,
      }).changes.length;
    f.db.recordRootCheck({
      rootId: root.id,
      availability: 'online',
      medium: 'internal',
      checkedAt: '2026-10-20T10:00:00Z',
    });
    const first = events();
    f.db.recordRootCheck({
      rootId: root.id,
      availability: 'online',
      medium: 'internal',
      checkedAt: '2026-10-20T11:00:00Z',
    });
    assert.equal(events(), first);
    assert.equal(
      f.db.listContentRootSummaries({ actor: f.actor })[0]?.lastCheckedAt,
      '2026-10-20T11:00:00Z',
    );
    f.db.recordRootCheck({ rootId: root.id, availability: 'offline', medium: 'internal' });
    assert.equal(events(), first + 1);
    f.db.recordRootCheck({ rootId: root.id, availability: 'offline', medium: 'removable' });
    assert.equal(events(), first + 2);
  } finally {
    f.db.close();
  }
});
