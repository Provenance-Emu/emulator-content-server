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
