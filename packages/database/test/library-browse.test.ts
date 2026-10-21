import assert from 'node:assert/strict';
import test from 'node:test';
import { type Actor, type AssetKind, DomainError } from '@ecs/domain';
import { type BrowseRecord, type BrowseSelection, CatalogDatabase } from '../src/index.js';

function fixture() {
  const db = new CatalogDatabase(':memory:');
  const owner = db.createUser({ username: 'owner', passwordHash: 'fixture', actorId: 'test' });
  const library = db.createLibrary(owner.id, 'Library');
  const actor: Actor = {
    kind: 'user',
    userId: owner.id,
    username: 'owner',
    isOwner: true,
    tokenKind: 'session',
    deviceId: null,
    scopes: ['read', 'write', 'admin'],
  };
  const root = db.createContentRoot({
    path: '/never/probed',
    label: 'Shelf',
    libraryId: library.id,
    actorId: owner.id,
  });
  const unassigned = db.createContentRoot({
    path: '/never/probed/unassigned',
    label: 'Legacy',
    libraryId: null,
    actorId: owner.id,
  });
  const select: BrowseSelection = {
    actor,
    libraryId: library.id,
    category: 'games',
    sort: 'name_asc',
    limit: 50,
  };
  const item = (title: string) =>
    db.createItem({
      libraryId: library.id,
      systemIdentifier: 'com.provenance.nes',
      title,
      md5: null,
      crc: null,
      actorId: owner.id,
    });
  const asset = (itemId: string, kind: AssetKind, name = kind as string, shareable = true) =>
    db.completeUpload({
      uploadId: db.createUpload({ userId: owner.id, guestGrantId: null, libraryId: library.id }).id,
      itemId,
      kind,
      displayName: name,
      relativePath: `${name}-${kind}`,
      baseRevision: db.getItem(itemId)?.revision ?? 1,
      sha256: 'a'.repeat(64),
      size: 1,
      md5: 'b'.repeat(32),
      crc: '12345678',
      shareable,
      actorId: owner.id,
      locationId: null,
    });
  const inspect = (
    rootId: string,
    files: Array<{ displayName: string; kind: string; systemId?: string | null }>,
  ) =>
    db.applyInspection({
      rootId,
      actorId: owner.id,
      online: true,
      files: files.map((file, index) => ({
        relativePath: `${index}`,
        displayName: file.displayName,
        kind: file.kind,
        systemId: file.systemId ?? null,
        size: 1,
        blocks: 1,
        availability: 'local',
      })),
    });
  return { db, owner, library, actor, root, unassigned, select, item, asset, inspect };
}
function identity(row: BrowseRecord) {
  return row.entityType === 'item'
    ? row.item.id
    : row.entityType === 'asset'
      ? row.asset.id
      : row.source.id;
}
function traverse(db: CatalogDatabase, selection: BrowseSelection) {
  const rows: BrowseRecord[] = [];
  let position: BrowseSelection['position'] = null;
  do {
    const page = db.browseLibrary({ ...selection, position });
    assert.ok(page.items.length <= selection.limit);
    rows.push(...page.items);
    position = page.next;
    assert.ok(rows.length <= 10001, 'pagination must terminate');
  } while (position);
  return rows;
}

test('10,000 mixed catalog records paginate uniquely before category and root projection', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 2000; i++) {
      const item = f.item(`Tied ${i % 10}`);
      if (i < 1000) {
        f.asset(item.id, 'rom');
        f.asset(item.id, 'artwork');
      }
    }
    const kinds = [
      'rom',
      'battery_save',
      'save_state',
      'artwork',
      'screenshot',
      'bios',
      'system_file',
    ];
    f.inspect(
      f.root.id,
      Array.from({ length: 5999 }, (_, i) => ({
        displayName: `Tied ${i % 10}`,
        kind: kinds[i % 7] ?? 'rom',
      })),
    );
    f.inspect(f.unassigned.id, [{ displayName: 'Legacy', kind: 'rom' }]);
    // 2,000 items + 2,000 assets + 6,000 sources = 10,000 original records.
    const tombstone = f.item('Deleted');
    f.asset(tombstone.id, 'rom');
    f.db.deleteItem(tombstone.id, f.owner.id);
    const first = f.db.browseLibrary(f.select);
    assert.equal(first.items.length, 50);
    const all = traverse(f.db, f.select);
    assert.equal(all.length, 2857); // 2,000 managed games and 857 scanned ROMs.
    assert.equal(new Set(all.map(identity)).size, 2857);
    const roots = traverse(f.db, { ...f.select, rootId: f.root.id });
    assert.equal(roots.length, 857);
    assert.ok(roots.every((row) => row.entityType === 'source'));
    assert.equal(traverse(f.db, { ...f.select, libraryId: null }).length, 1);
    for (const [category, expectedKinds, count] of [
      ['saves', ['battery_save', 'save_state'], 1714],
      ['media', ['artwork', 'screenshot'], 2714],
      ['system_files', ['bios', 'system_file'], 1714],
    ] as const) {
      const rows = traverse(f.db, { ...f.select, category });
      assert.equal(rows.length, count);
      assert.ok(
        rows.every(
          (row) =>
            row.entityType !== 'item' &&
            (expectedKinds as readonly string[]).includes(
              row.entityType === 'asset' ? row.asset.kind : row.source.kind,
            ),
        ),
      );
    }
  } finally {
    f.db.close();
  }
});

test('literal Unicode search and stable tie traversal', () => {
  const f = fixture();
  try {
    for (const name of [
      'Éclair',
      'éclair',
      'E\u0301clair',
      'literal%_\\',
      'literalXX',
      'Same',
      'same',
      'Same',
    ])
      f.item(name);
    f.inspect(f.root.id, [{ displayName: 'same', kind: 'rom' }]);
    assert.equal(traverse(f.db, { ...f.select, search: 'ÉCLAIR' }).length, 3);
    assert.equal(traverse(f.db, { ...f.select, search: '%_\\' }).length, 1);
    const asc = traverse(f.db, { ...f.select, limit: 1 });
    const desc = traverse(f.db, { ...f.select, limit: 1, sort: 'name_desc' });
    assert.equal(asc.length, 9);
    assert.equal(new Set(asc.map(identity)).size, 9);
    assert.deepEqual(desc.map(identity), asc.map(identity).reverse());
    assert.equal(traverse(f.db, { ...f.select, systemId: 'unknown' }).length, 1);
    assert.equal(traverse(f.db, { ...f.select, systemId: 'com.provenance.nes' }).length, 8);
  } finally {
    f.db.close();
  }
});

test('memberships and item read grants are additive and reevaluated on every page', () => {
  const f = fixture();
  try {
    const user = f.db.createUser({
      username: 'reader',
      passwordHash: 'fixture',
      actorId: f.owner.id,
    });
    const actor: Actor = { ...f.actor, userId: user.id, isOwner: false };
    const first = f.item('A');
    const second = f.item('B');
    f.inspect(f.root.id, [{ displayName: 'C', kind: 'rom' }]);
    f.db.setItemPermission(first.id, user.id, 'read', f.owner.id);
    assert.deepEqual(traverse(f.db, { ...f.select, actor }).map(identity), [first.id]);
    f.db.setMember(f.library.id, user.id, 'reader', f.owner.id);
    f.db.setItemPermission(second.id, user.id, 'write', f.owner.id);
    assert.equal(traverse(f.db, { ...f.select, actor }).length, 3);
    const position = f.db.browseLibrary({ ...f.select, actor, limit: 1 }).next;
    f.db.removeMember(f.library.id, user.id, f.owner.id);
    f.db.removeItemPermission(first.id, user.id, f.owner.id);
    assert.throws(
      () => f.db.browseLibrary({ ...f.select, actor, position }),
      (error: unknown) => error instanceof DomainError && error.code === 'invalid-cursor',
    );
    assert.equal(traverse(f.db, { ...f.select, actor }).length, 0);
    assert.equal(traverse(f.db, { ...f.select, actor: { ...actor, localTrust: true } }).length, 3);
    for (const denied of [
      { ...f.actor, scopes: [] },
      { ...actor, localTrust: true, scopes: [] },
    ] as Actor[])
      assert.deepEqual(f.db.browseLibrary({ ...f.select, actor: denied }).items, []);
  } finally {
    f.db.close();
  }
});

test('guest scopes restrict sources, kinds and preview artwork before pagination', () => {
  const f = fixture();
  try {
    const item = f.item('Game');
    f.asset(item.id, 'rom');
    const privateArt = f.asset(item.id, 'artwork', 'Private', false);
    const save = f.asset(item.id, 'battery_save', 'Save');
    f.asset(item.id, 'bios');
    const onlyArt = f.item('Art only');
    f.asset(onlyArt.id, 'artwork');
    f.inspect(f.root.id, [
      { displayName: 'Source', kind: 'rom' },
      { displayName: 'BIOS', kind: 'bios' },
    ]);
    const guest: Actor = {
      kind: 'guest',
      grantId: 'fixture',
      libraryId: f.library.id,
      itemId: item.id,
      capabilities: ['read'],
    };
    assert.equal(f.db.browseLibrary({ ...f.select, actor: guest }).items.length, 1);
    const game = f.db.browseLibrary({ ...f.select, actor: guest }).items[0];
    assert.ok(game?.entityType === 'item');
    assert.equal(game.previewAsset, null);
    assert.deepEqual(
      traverse(f.db, { ...f.select, actor: guest, category: 'saves' }).map(identity),
      [save.id],
    );
    assert.equal(traverse(f.db, { ...f.select, actor: guest, category: 'media' }).length, 0);
    assert.equal(traverse(f.db, { ...f.select, actor: guest, category: 'system_files' }).length, 0);
    assert.equal(traverse(f.db, { ...f.select, actor: { ...guest, itemId: null } }).length, 2);
    const restricted = { ...guest, capabilities: ['read', 'share_restricted'] } as Actor;
    const preview = f.db.browseLibrary({ ...f.select, actor: restricted }).items[0];
    assert.ok(preview?.entityType === 'item');
    assert.equal(preview.previewAsset?.id, privateArt.id);
    assert.equal(traverse(f.db, { ...f.select, actor: { ...guest, capabilities: [] } }).length, 0);
    assert.equal(traverse(f.db, { ...f.select, actor: guest, libraryId: null }).length, 0);
    f.db.deleteAsset(privateArt.id, f.owner.id);
    const publicArt = f.asset(item.id, 'artwork', 'Public');
    const updated = f.db.browseLibrary({ ...f.select, actor: guest }).items[0];
    assert.ok(updated?.entityType === 'item');
    assert.equal(updated.previewAsset?.id, publicArt.id);
  } finally {
    f.db.close();
  }
});

test('vanished anchor requires refresh', () => {
  const f = fixture();
  try {
    const first = f.item('A');
    f.item('B');
    const position = f.db.browseLibrary({ ...f.select, limit: 1 }).next;
    assert.deepEqual(position, { entityType: 'item', id: first.id });
    f.db.deleteItem(first.id, f.owner.id);
    assert.throws(
      () => f.db.browseLibrary({ ...f.select, position }),
      (error: unknown) => error instanceof DomainError && error.code === 'invalid-cursor',
    );
  } finally {
    f.db.close();
  }
});

test('browse library discovery includes only live item read grants and preserves legacy membership lists', () => {
  const f = fixture();
  try {
    const user = f.db.createUser({
      username: 'reader',
      passwordHash: 'fixture',
      actorId: f.owner.id,
    });
    const actor: Actor = { ...f.actor, userId: user.id, isOwner: false };
    const item = f.item('Only granted game');
    const unrelated = f.db.createLibrary(f.owner.id, 'Unrelated');
    assert.deepEqual(f.db.listBrowseLibraries(actor), []);
    f.db.setItemPermission(item.id, user.id, 'read', f.owner.id);
    assert.deepEqual(
      f.db.listBrowseLibraries(actor).map((row) => row.id),
      [f.library.id],
    );
    assert.deepEqual(f.db.listLibraries(user.id, false), []);
    assert.deepEqual(f.db.visibleLibraryIds(actor), []);
    assert.deepEqual(f.db.listBrowseLibraries({ ...actor, scopes: [] }), []);
    f.db.deleteItem(item.id, f.owner.id);
    assert.deepEqual(f.db.listBrowseLibraries(actor), []);
    f.db.setMember(unrelated.id, user.id, 'reader', f.owner.id);
    assert.deepEqual(
      f.db.listBrowseLibraries(actor).map((row) => row.id),
      [unrelated.id],
    );
    assert.equal(f.db.listBrowseLibraries({ ...actor, localTrust: true }).length, 2);
    assert.deepEqual(f.db.listBrowseLibraries({ ...actor, localTrust: true, scopes: [] }), []);
    assert.equal(f.db.listBrowseLibraries(f.actor).length, 2);
    const guest: Actor = {
      kind: 'guest',
      grantId: 'fixture',
      libraryId: f.library.id,
      itemId: null,
      capabilities: ['read'],
    };
    assert.deepEqual(
      f.db.listBrowseLibraries(guest).map((row) => row.id),
      [f.library.id],
    );
    assert.deepEqual(f.db.listBrowseLibraries({ ...guest, capabilities: [] }), []);
  } finally {
    f.db.close();
  }
});

test('browse limits reject oversized pages and bounded reads avoid legacy manifest and source lists', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 101; i++) f.item(`Game ${i}`);
    f.inspect(f.root.id, [{ displayName: 'Source', kind: 'rom' }]);
    // These legacy methods load whole collections; the page must hydrate only its selected records.
    f.db.manifest = () => {
      throw new Error('Unbounded manifest read');
    };
    f.db.listSources = () => {
      throw new Error('Unbounded source read');
    };
    const page = f.db.browseLibrary({ ...f.select, limit: 100 });
    assert.equal(page.items.length, 100);
    assert.ok(page.next);
    assert.equal(
      f.db.browseLibrary({ ...f.select, limit: 100, position: page.next }).items.length,
      2,
    );
    for (const limit of [0, -1, 101, 1.5])
      assert.throws(
        () => f.db.browseLibrary({ ...f.select, limit }),
        (error: unknown) => error instanceof DomainError && error.code === 'invalid-query',
      );
  } finally {
    f.db.close();
  }
});

test('system facets count every readable game before paging and multi-selection keeps unknown games', () => {
  const f = fixture();
  try {
    f.item('Managed NES');
    f.inspect(f.root.id, [
      { displayName: 'Source NES', kind: 'rom', systemId: 'com.provenance.nes' },
      { displayName: 'Source SNES', kind: 'rom', systemId: 'com.provenance.snes' },
      { displayName: 'Unknown disc', kind: 'rom' },
      { displayName: 'Art only', kind: 'artwork', systemId: 'com.provenance.psx' },
    ]);
    const query = { ...f.select, limit: 1, systemIds: ['com.provenance.nes', 'unknown'] };
    const page = f.db.browseLibrary(query) as ReturnType<CatalogDatabase['browseLibrary']> & {
      systemCounts?: { systemId: string; count: number }[];
    };
    assert.deepEqual(page.systemCounts, [
      { systemId: 'com.provenance.nes', count: 2 },
      { systemId: 'com.provenance.snes', count: 1 },
      { systemId: 'unknown', count: 1 },
    ]);
    const rows = traverse(f.db, { ...query, limit: 50 });
    assert.equal(rows.length, 3);
    assert.equal(
      rows.some((r) => r.entityType === 'source' && r.source.displayName === 'Source SNES'),
      false,
    );
    const noRead = { ...query, actor: { ...f.actor, scopes: [] } as Actor };
    assert.deepEqual((f.db.browseLibrary(noRead) as typeof page).systemCounts, []);
  } finally {
    f.db.close();
  }
});
