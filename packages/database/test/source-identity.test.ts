import assert from 'node:assert/strict';
import { copyFile, link, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { CatalogDatabase } from '../src/index.js';

async function inspected(root: string, relativePath: string) {
  const info = await stat(join(root, relativePath), { bigint: true });
  return {
    relativePath,
    displayName: basename(relativePath),
    size: Number(info.size),
    blocks: Number(info.blocks),
    kind: 'rom',
    systemId: null,
    availability: 'local' as const,
    filesystemIdentity: `${info.dev}:${info.ino}:${info.birthtimeNs}`,
    mtimeMs: Number(info.mtimeNs) / 1e6,
  };
}
async function fixture(
  run: (f: {
    db: CatalogDatabase;
    root: string;
    rootId: string;
    actorId: string;
    filename: string;
  }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-source-identity-'));
  const root = join(dir, 'root');
  await mkdir(root);
  const filename = join(dir, 'catalog.sqlite');
  const db = new CatalogDatabase(filename);
  const user = db.createUser({ username: 'owner', passwordHash: 'fixture', actorId: 'test' });
  const library = db.createLibrary(user.id, 'Library');
  const registered = db.createContentRoot({
    path: root,
    label: 'Root',
    libraryId: library.id,
    actorId: user.id,
  });
  try {
    await run({ db, root, rootId: registered.id, actorId: user.id, filename });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const selection = {
  id: 'saved-metadata',
  kind: 'metadata' as const,
  providerId: 'test',
  title: 'Saved title',
  confidence: 'name' as const,
  originKind: null,
  contentAvailable: false,
  contentType: null,
  fileName: null,
  updatedAt: '',
  metadata: {},
};

test('a volume device-number change preserves same-path choices and invalidates the old identification stamp', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'generated.nes'), 'generated');
    const file = await inspected(f.root, 'generated.nes');
    f.db.applyInspection({ ...f, online: true, files: [file] });
    const source = f.db.listSources(f.rootId)[0];
    assert.ok(source);
    const saved = f.db.saveSourceMatch(source.id, 0, 'metadata', selection, null, f.actorId);
    const identity = file.filesystemIdentity.split(':');
    identity[0] = String(BigInt(identity[0] ?? '0') + 1n);
    const remounted = { ...file, filesystemIdentity: identity.join(':') };
    f.db.applyInspection({ ...f, online: true, files: [remounted] });
    assert.equal(f.db.listSources(f.rootId)[0]?.id, source.id);
    assert.deepEqual(f.db.sourceMatches(source.id), saved);
    assert.equal(
      f.db.sourceInspectionIdentity(source.id)?.filesystemIdentity,
      remounted.filesystemIdentity,
    );
    const reopened = new CatalogDatabase(f.filename);
    try {
      assert.deepEqual(reopened.sourceMatches(source.id), saved);
    } finally {
      reopened.close();
    }
  }));

for (const changed of ['inode', 'birth', 'size', 'mtime'] as const) {
  test(`a device-number change with changed ${changed} still detaches replacement choices`, async () =>
    fixture(async (f) => {
      await writeFile(join(f.root, 'generated.nes'), 'generated');
      const file = await inspected(f.root, 'generated.nes');
      f.db.applyInspection({ ...f, online: true, files: [file] });
      const source = f.db.listSources(f.rootId)[0];
      assert.ok(source);
      f.db.saveSourceMatch(source.id, 0, 'metadata', selection, null, f.actorId);
      const identity = file.filesystemIdentity.split(':');
      identity[0] = String(BigInt(identity[0] ?? '0') + 1n);
      if (changed === 'inode') identity[1] = String(BigInt(identity[1] ?? '0') + 1n);
      if (changed === 'birth') identity[2] = String(BigInt(identity[2] ?? '0') + 1n);
      f.db.applyInspection({
        ...f,
        online: true,
        files: [
          {
            ...file,
            filesystemIdentity: identity.join(':'),
            ...(changed === 'size' ? { size: file.size + 1 } : {}),
            ...(changed === 'mtime' ? { mtimeMs: file.mtimeMs + 1 } : {}),
          },
        ],
      });
      const replacement = f.db.listSources(f.rootId)[0];
      assert.ok(replacement);
      assert.notEqual(replacement.id, source.id);
      assert.deepEqual(f.db.sourceMatches(replacement.id).matches, []);
    }));
}

test('a real rename keeps the source ID, saved selections and revision through reopen', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'before.nes'), 'generated');
    const scan = (files: Awaited<ReturnType<typeof inspected>>[]) =>
      f.db.applyInspection({ ...f, files, online: true });
    scan([await inspected(f.root, 'before.nes')]);
    const source = f.db.listSources(f.rootId)[0];
    assert.ok(source);
    const saved = f.db.saveSourceMatch(source.id, 0, 'metadata', selection, null, f.actorId);
    await mkdir(join(f.root, 'folder'));
    await rename(join(f.root, 'before.nes'), join(f.root, 'folder', 'after.nes'));
    scan([await inspected(f.root, 'folder/after.nes')]);
    assert.equal(f.db.listSources(f.rootId)[0]?.id, source.id);
    assert.equal(f.db.getSource(source.id)?.relativePath, 'folder/after.nes');
    assert.deepEqual(f.db.sourceMatches(source.id), saved);
    const reopened = new CatalogDatabase(f.filename);
    try {
      assert.deepEqual(reopened.sourceMatches(source.id), saved);
      assert.equal(reopened.integrity(), 'ok');
    } finally {
      reopened.close();
    }
  }));

test('artwork roles persist independently and deleting one role preserves the others', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'roles.nes'), 'generated');
    f.db.applyInspection({ ...f, files: [await inspected(f.root, 'roles.nes')], online: true });
    const source = f.db.listSources(f.rootId)[0];
    assert.ok(source);
    const artwork = (id: string, artworkRole: 'front' | 'back' | 'disc' | 'manual') => ({
      ...selection,
      id,
      kind: 'artwork' as const,
      artworkRole,
      contentAvailable: true,
      contentType: 'image/png',
      fileName: `${artworkRole}.png`,
    });
    let state = f.db.saveSourceMatch(
      source.id,
      0,
      'artwork',
      artwork('front', 'front'),
      Buffer.from([1]),
      f.actorId,
    );
    state = f.db.saveSourceMatch(
      source.id,
      state.revision,
      'artwork',
      artwork('back', 'back'),
      Buffer.from([2]),
      f.actorId,
    );
    state = f.db.saveSourceMatch(
      source.id,
      state.revision,
      'artwork',
      artwork('disc', 'disc'),
      Buffer.from([3]),
      f.actorId,
    );
    state = f.db.saveSourceMatch(
      source.id,
      state.revision,
      'artwork',
      artwork('manual', 'manual'),
      Buffer.from([4]),
      f.actorId,
    );
    assert.deepEqual(
      state.matches.map((match) => match.artworkRole),
      ['back', 'disc', 'front', 'manual'],
    );
    assert.deepEqual(f.db.sourceMatchContent(source.id, 'artwork', 'back'), new Uint8Array([2]));
    state = f.db.saveSourceMatch(
      source.id,
      state.revision,
      'artwork',
      null,
      null,
      f.actorId,
      'back',
    );
    assert.deepEqual(
      state.matches.map((match) => match.artworkRole),
      ['disc', 'front', 'manual'],
    );
    assert.deepEqual(f.db.sourceMatchContent(source.id, 'artwork'), new Uint8Array([1]));
  }));

test('matching identifications are bounded and invalidated by their stamp', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'identity.nes'), 'generated');
    f.db.applyInspection({ ...f, files: [await inspected(f.root, 'identity.nes')], online: true });
    const source = f.db.listSources(f.rootId)[0];
    assert.ok(source);
    f.db.saveMatchingIdentification(source.id, 'fingerprint-v1', {
      systems: ['nes'],
      confidence: 0.9,
    });
    assert.deepEqual(f.db.matchingIdentification(source.id, 'fingerprint-v1'), {
      systems: ['nes'],
      confidence: 0.9,
    });
    assert.equal(f.db.matchingIdentification(source.id, 'fingerprint-v2'), null);
    assert.throws(() => f.db.saveMatchingIdentification(source.id, 'huge', 'x'.repeat(256 * 1024)));
  }));

test('a copy and ambiguous hard links never steal a missing source identity', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'before.nes'), 'generated');
    f.db.applyInspection({ ...f, files: [await inspected(f.root, 'before.nes')], online: true });
    const source = f.db.listSources(f.rootId)[0];
    assert.ok(source);
    f.db.saveSourceMatch(source.id, 0, 'metadata', selection, null, f.actorId);
    await copyFile(join(f.root, 'before.nes'), join(f.root, 'copy.nes'));
    await rename(join(f.root, 'before.nes'), join(f.root, 'after.nes'));
    await link(join(f.root, 'after.nes'), join(f.root, 'hardlink.nes'));
    f.db.applyInspection({
      ...f,
      files: await Promise.all(
        ['copy.nes', 'after.nes', 'hardlink.nes'].map((name) => inspected(f.root, name)),
      ),
      online: true,
    });
    assert.equal(f.db.getSource(source.id), null);
    for (const row of f.db.listSources(f.rootId))
      assert.equal(f.db.sourceMatches(row.id).revision, 0);
  }));

test('replacement at the old path cannot inherit matches or recover an ambiguous moved original', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'before.nes'), 'generated');
    f.db.applyInspection({ ...f, files: [await inspected(f.root, 'before.nes')], online: true });
    const source = f.db.listSources(f.rootId)[0];
    assert.ok(source);
    f.db.saveSourceMatch(source.id, 0, 'metadata', selection, null, f.actorId);
    await rename(join(f.root, 'before.nes'), join(f.root, 'after.nes'));
    await writeFile(join(f.root, 'before.nes'), 'replacement');
    f.db.applyInspection({
      ...f,
      files: await Promise.all(['before.nes', 'after.nes'].map((name) => inspected(f.root, name))),
      online: true,
    });
    assert.equal(f.db.getSource(source.id), null);
    for (const row of f.db.listSources(f.rootId))
      assert.equal(f.db.sourceMatches(row.id).revision, 0);
  }));

test('changed modification guards and path swaps never transfer old selections', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'first.nes'), 'first');
    await writeFile(join(f.root, 'second.nes'), 'second');
    f.db.applyInspection({
      ...f,
      files: await Promise.all(['first.nes', 'second.nes'].map((name) => inspected(f.root, name))),
      online: true,
    });
    const originals = f.db.listSources(f.rootId);
    for (const source of originals)
      f.db.saveSourceMatch(source.id, 0, 'metadata', selection, null, f.actorId);
    await rename(join(f.root, 'first.nes'), join(f.root, 'temporary'));
    await rename(join(f.root, 'second.nes'), join(f.root, 'first.nes'));
    await rename(join(f.root, 'temporary'), join(f.root, 'second.nes'));
    f.db.applyInspection({
      ...f,
      files: await Promise.all(['first.nes', 'second.nes'].map((name) => inspected(f.root, name))),
      online: true,
    });
    for (const source of originals) assert.equal(f.db.getSource(source.id), null);
    const before = f.db.listSources(f.rootId)[0];
    assert.ok(before);
    await rename(join(f.root, before.relativePath), join(f.root, 'edited.nes'));
    const changed = await inspected(f.root, 'edited.nes');
    changed.mtimeMs += 1;
    f.db.applyInspection({ ...f, files: [changed], online: true });
    assert.equal(f.db.getSource(before.id), null);
  }));

test('explicit relocation and cloning keep snapshots, reject collisions and cross-library targets', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'before.nes'), 'generated');
    f.db.applyInspection({ ...f, files: [await inspected(f.root, 'before.nes')], online: true });
    const source = f.db.listSources(f.rootId)[0];
    assert.ok(source);
    f.db.saveSourceMatch(source.id, 0, 'metadata', selection, null, f.actorId);
    const art = {
      ...selection,
      id: 'art',
      kind: 'artwork' as const,
      contentAvailable: true,
      contentType: 'image/png',
    };
    f.db.saveSourceMatch(source.id, 1, 'artwork', art, Buffer.from('generated image'), f.actorId);
    const target = f.db.createContentRoot({
      path: `${f.root}-target`,
      label: 'Target',
      libraryId: source.libraryId,
      actorId: f.actorId,
    });
    await copyFile(join(f.root, 'before.nes'), join(f.root, 'copy.nes'));
    const file = await inspected(f.root, 'copy.nes');
    const copied = f.db.cloneSource({ ...f, sourceId: source.id, targetRootId: target.id, file });
    assert.notEqual(copied.id, source.id);
    assert.deepEqual(f.db.sourceMatches(copied.id), {
      ...f.db.sourceMatches(source.id),
      sourceId: copied.id,
    });
    assert.deepEqual(
      f.db.sourceMatchContent(copied.id, 'artwork'),
      new Uint8Array(Buffer.from('generated image')),
    );
    assert.throws(
      () => f.db.cloneSource({ ...f, sourceId: source.id, targetRootId: target.id, file }),
      /already indexed/,
    );
    await rename(join(f.root, 'before.nes'), join(f.root, 'moved.nes'));
    const moved = f.db.relocateSource({
      ...f,
      sourceId: source.id,
      targetRootId: target.id,
      file: await inspected(f.root, 'moved.nes'),
    });
    assert.equal(moved.id, source.id);
    assert.equal(moved.rootId, target.id);
    assert.equal(f.db.sourceMatches(moved.id).revision, 2);
    const other = f.db.createLibrary(f.actorId, 'Other');
    const otherRoot = f.db.createContentRoot({
      path: `${f.root}-other`,
      label: 'Other',
      libraryId: other.id,
      actorId: f.actorId,
    });
    for (const method of ['cloneSource', 'relocateSource'] as const)
      assert.throws(
        () => f.db[method]({ ...f, sourceId: source.id, targetRootId: otherRoot.id, file }),
        /same library/,
      );
    assert.equal(f.db.getSource(source.id)?.rootId, target.id);
  }));

test('passive scans never transfer identities across roots but explicit unassigned organization can', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'before.nes'), 'generated');
    const initial = await inspected(f.root, 'before.nes');
    f.db.applyInspection({ ...f, files: [initial], online: true });
    const original = f.db.listSources(f.rootId)[0];
    assert.ok(original);
    f.db.saveSourceMatch(original.id, 0, 'metadata', selection, null, f.actorId);
    const target = f.db.createContentRoot({
      path: `${f.root}-second`,
      label: 'Second',
      libraryId: original.libraryId,
      actorId: f.actorId,
    });
    f.db.applyInspection({ ...f, rootId: target.id, files: [initial], online: true });
    assert.notEqual(f.db.listSources(target.id)[0]?.id, original.id);
    assert.equal(f.db.sourceMatches(original.id).revision, 1);
    const unassigned = f.db.createContentRoot({
      path: `${f.root}-unassigned`,
      label: 'Unassigned',
      libraryId: null,
      actorId: f.actorId,
    });
    const destination = f.db.createContentRoot({
      path: `${f.root}-unassigned-target`,
      label: 'Destination',
      libraryId: null,
      actorId: f.actorId,
    });
    f.db.applyInspection({ ...f, rootId: unassigned.id, files: [initial], online: true });
    const source = f.db.listSources(unassigned.id)[0];
    assert.ok(source);
    const moved = f.db.relocateSource({
      ...f,
      sourceId: source.id,
      targetRootId: destination.id,
      file: initial,
    });
    assert.equal(moved.id, source.id);
    assert.equal(moved.libraryId, null);
    assert.equal(moved.rootId, destination.id);
    assert.throws(
      () => f.db.cloneSource({ ...f, sourceId: source.id, targetRootId: target.id, file: initial }),
      /same library/,
    );
  }));

test('moving the same file into a different category retains saved selections and updates its kind', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'before.nes'), 'generated');
    f.db.applyInspection({ ...f, files: [await inspected(f.root, 'before.nes')], online: true });
    const source = f.db.listSources(f.rootId)[0];
    assert.ok(source);
    const saved = f.db.saveSourceMatch(source.id, 0, 'metadata', selection, null, f.actorId);
    await mkdir(join(f.root, 'bios'));
    await rename(join(f.root, 'before.nes'), join(f.root, 'bios', 'before.nes'));
    const file = { ...(await inspected(f.root, 'bios/before.nes')), kind: 'bios' };
    f.db.applyInspection({ ...f, files: [file], online: true });
    assert.equal(f.db.listSources(f.rootId)[0]?.id, source.id);
    assert.equal(f.db.getSource(source.id)?.kind, 'bios');
    assert.deepEqual(f.db.sourceMatches(source.id), saved);
  }));

test('missing sources retain identity and snapshots internally through reopen until root removal', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'before.nes'), 'generated');
    const initial = await inspected(f.root, 'before.nes');
    f.db.applyInspection({ ...f, online: true, files: [initial] });
    const source = f.db.listSources(f.rootId)[0];
    assert.ok(source);
    const saved = f.db.saveSourceMatch(source.id, 0, 'metadata', selection, null, f.actorId);
    f.db.applyInspection({ ...f, online: true, files: [] });
    const reopened = new CatalogDatabase(f.filename);
    try {
      assert.equal(reopened.getSource(source.id), null);
      assert.deepEqual(reopened.listSources(f.rootId), []);
      assert.equal(
        reopened.inspectionMoveCandidates(f.rootId)[0]?.relativePath,
        initial.relativePath,
      );
      const target = reopened.createContentRoot({
        path: `${f.root}-later`,
        label: 'Later',
        libraryId: source.libraryId,
        actorId: f.actorId,
      });
      reopened.applyInspection({
        ...f,
        rootId: target.id,
        online: true,
        files: [{ ...initial, relativePath: 'later.nes' }],
        verifiedMoveSourceIds: [source.id],
      });
      assert.equal(reopened.getSource(source.id)?.rootId, target.id);
      assert.deepEqual(reopened.sourceMatches(source.id), saved);
      reopened.applyInspection({ ...f, rootId: target.id, online: true, files: [] });
      reopened.deleteContentRoot(target.id, f.actorId);
      assert.equal(
        reopened.inspectionMoveCandidates(f.rootId).some((candidate) => candidate.id === source.id),
        false,
      );
      assert.equal(reopened.integrity(), 'ok');
    } finally {
      reopened.close();
    }
  }));

test('unverified, cross-library, unknown, changed or ambiguous cross-root facts never transfer selections', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'before.nes'), 'generated');
    const initial = await inspected(f.root, 'before.nes');
    f.db.applyInspection({ ...f, online: true, files: [initial] });
    const source = f.db.listSources(f.rootId)[0];
    assert.ok(source);
    f.db.saveSourceMatch(source.id, 0, 'metadata', selection, null, f.actorId);
    const other = f.db.createLibrary(f.actorId, 'Other');
    for (const reason of [
      'unverified',
      'cross-library',
      'unknown',
      'mtime',
      'size',
      'ambiguous',
    ] as const) {
      const target = f.db.createContentRoot({
        path: `${f.root}-${reason}`,
        label: reason,
        libraryId: reason === 'cross-library' ? other.id : source.libraryId,
        actorId: f.actorId,
      });
      const file = {
        ...initial,
        relativePath: `${reason}.nes`,
        ...(reason === 'unknown' ? { filesystemIdentity: null } : {}),
        ...(reason === 'mtime' ? { mtimeMs: initial.mtimeMs + 1 } : {}),
        ...(reason === 'size' ? { size: initial.size + 1 } : {}),
      };
      f.db.applyInspection({
        ...f,
        rootId: target.id,
        online: true,
        files: reason === 'ambiguous' ? [file, { ...file, relativePath: 'second.nes' }] : [file],
        verifiedMoveSourceIds: reason === 'unverified' ? [] : [source.id],
      });
      for (const row of f.db.listSources(target.id)) {
        assert.notEqual(row.id, source.id);
        assert.equal(f.db.sourceMatches(row.id).revision, 0);
      }
      f.db.deleteContentRoot(target.id, f.actorId);
    }
    assert.equal(f.db.sourceMatches(source.id).revision, 1);
  }));

test('automatic copy ownership and snapshots persist, synchronize atomically, and survive policy disable', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'before.nes'), 'generated');
    const initial = await inspected(f.root, 'before.nes');
    f.db.applyInspection({ ...f, online: true, files: [initial] });
    const source = f.db.listSources(f.rootId)[0];
    assert.ok(source);
    f.db.saveSourceMatch(source.id, 0, 'metadata', selection, null, f.actorId);
    const target = f.db.createContentRoot({
      path: `${f.root}-copy`,
      label: 'Copy',
      libraryId: source.libraryId,
      actorId: f.actorId,
    });
    const policy = {
      sourceRootId: f.rootId,
      targetRootId: target.id,
      libraryId: source.libraryId,
      sourceRootPath: f.root,
      targetRootPath: target.path,
      mode: 'copy' as const,
      enabledBy: f.actorId,
      enabledAt: '2026-10-21T00:00:00Z',
    };
    f.db.setSourceOrganizationPolicy(policy);
    const copy = f.db.cloneSource({
      ...f,
      sourceId: source.id,
      targetRootId: target.id,
      file: { ...initial, relativePath: 'copy.nes', filesystemIdentity: '1:2:3' },
      organizationCopy: {
        sourceRootId: f.rootId,
        originalIdentity: initial.filesystemIdentity,
        sha256: 'a'.repeat(64),
      },
    });
    const owned = f.db.getSourceOrganizationCopy(f.rootId, source.id);
    assert.equal(owned?.copySourceId, copy.id);
    assert.equal(owned?.copyIdentity, '1:2:3');
    f.db.clearSourceOrganizationPolicy(f.rootId);
    assert.equal(f.db.getSourceOrganizationPolicy(f.rootId), null);
    f.db.setSourceOrganizationPolicy(policy);
    assert.deepEqual(f.db.getSourceOrganizationCopy(f.rootId, source.id), owned);
    const saved = f.db.saveSourceMatch(
      source.id,
      1,
      'artwork',
      {
        ...selection,
        id: 'art',
        kind: 'artwork',
        contentAvailable: true,
        contentType: 'image/png',
      },
      Buffer.from('generated artwork'),
      f.actorId,
    );
    const synced = f.db.synchronizeSourceMatches(source.id, copy.id);
    assert.deepEqual(synced, { ...saved, sourceId: copy.id });
    assert.deepEqual(f.db.sourceMatches(source.id), saved);
    assert.deepEqual(
      f.db.sourceMatchContent(copy.id, 'artwork'),
      new Uint8Array(Buffer.from('generated artwork')),
    );
    assert.deepEqual(f.db.synchronizeSourceMatches(source.id, copy.id), synced);
    const reopened = new CatalogDatabase(f.filename);
    try {
      assert.deepEqual(reopened.getSourceOrganizationPolicy(f.rootId), policy);
      assert.deepEqual(reopened.getSourceOrganizationCopy(f.rootId, source.id), owned);
      assert.deepEqual(reopened.sourceMatches(copy.id), synced);
      assert.equal(reopened.integrity(), 'ok');
    } finally {
      reopened.close();
    }
    f.db.clearSourceOrganizationPolicy(f.rootId);
    const otherTarget = f.db.createContentRoot({
      path: `${f.root}-other-copy`,
      label: 'Other Copy',
      libraryId: source.libraryId,
      actorId: f.actorId,
    });
    f.db.setSourceOrganizationPolicy({
      ...policy,
      targetRootId: otherTarget.id,
      targetRootPath: otherTarget.path,
    });
    assert.equal(f.db.getSourceOrganizationCopy(f.rootId, source.id), null);
    assert.equal(f.db.getSource(copy.id)?.rootId, target.id);
    f.db.deleteContentRoot(otherTarget.id, f.actorId);
    assert.equal(f.db.getSourceOrganizationPolicy(f.rootId), null);
  }));

test('the same inode returning to its original missing path restores saved selections', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'before.nes'), 'generated');
    const initial = await inspected(f.root, 'before.nes');
    f.db.applyInspection({ ...f, online: true, files: [initial] });
    const source = f.db.listSources(f.rootId)[0];
    assert.ok(source);
    const saved = f.db.saveSourceMatch(source.id, 0, 'metadata', selection, null, f.actorId);
    await rename(join(f.root, 'before.nes'), join(f.root, 'held'));
    f.db.applyInspection({ ...f, online: true, files: [] });
    await rename(join(f.root, 'held'), join(f.root, 'before.nes'));
    f.db.applyInspection({ ...f, online: true, files: [await inspected(f.root, 'before.nes')] });
    assert.equal(f.db.listSources(f.rootId)[0]?.id, source.id);
    assert.deepEqual(f.db.sourceMatches(source.id), saved);
  }));

test('a verified cross-root move can occupy a path held only by a missing tombstone', async () =>
  fixture(async (f) => {
    await writeFile(join(f.root, 'before.nes'), 'generated');
    const initial = await inspected(f.root, 'before.nes');
    f.db.applyInspection({ ...f, online: true, files: [initial] });
    const source = f.db.listSources(f.rootId)[0];
    assert.ok(source);
    const saved = f.db.saveSourceMatch(source.id, 0, 'metadata', selection, null, f.actorId);
    const target = f.db.createContentRoot({
      path: `${f.root}-target`,
      label: 'Target',
      libraryId: source.libraryId,
      actorId: f.actorId,
    });
    const file = { ...initial, relativePath: 'after.nes' };
    f.db.applyInspection({
      ...f,
      rootId: target.id,
      online: true,
      files: [{ ...file, filesystemIdentity: '1:2:3' }],
    });
    const former = f.db.listSources(target.id)[0];
    assert.ok(former);
    f.db.applyInspection({ ...f, rootId: target.id, online: true, files: [] });
    f.db.applyInspection({
      ...f,
      rootId: target.id,
      online: true,
      files: [file],
      verifiedMoveSourceIds: [source.id],
    });
    assert.equal(f.db.listSources(target.id)[0]?.id, source.id);
    assert.equal(f.db.getSource(former.id), null);
    assert.deepEqual(f.db.sourceMatches(source.id), saved);
  }));
