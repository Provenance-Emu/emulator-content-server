import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import { createLibraryFolders } from '../src/lib/library-folders.js';
import { folderFixture, selection } from './folder-fixture.js';

test('opening folders is read-only and adding scans only the returned registration', async (t) => {
  const f = folderFixture(t);
  const folders = createLibraryFolders(f.client, f.context);
  await folders.load({ libraryId: 'library' });
  assert.equal(
    f.calls.some((c) => c.path.endsWith('/scan')),
    false,
  );
  assert.equal(await folders.add(selection()), true);
  assert.deepEqual(
    f.calls.filter((c) => c.path.endsWith('/scan')).map((c) => c.path),
    ['/api/v1/roots/root-0/scan'],
  );
  assert.deepEqual(
    f.roots.map((r) => [r.label, r.libraryId]),
    [['Games', 'library']],
  );
});
test('scan failure retains registration and retry never adds it again, even after refresh fails', async (t) => {
  const f = folderFixture(t);
  const folders = createLibraryFolders(f.client, f.context);
  await folders.load({ libraryId: 'library' });
  f.override(async (path) =>
    path.endsWith('/scan') || path.endsWith('/root-summaries')
      ? Response.json({ title: 'Offline' }, { status: 503 })
      : null,
  );
  assert.equal(await folders.add(selection()), true);
  assert.equal(get(folders).summaries[0]?.root.id, 'root-0');
  assert.match(get(folders).scanFailures['root-0'] ?? '', /Offline/);
  f.override(null);
  await folders.retryScan('root-0');
  assert.equal(f.roots.length, 1);
  assert.equal(get(folders).scanFailures['root-0'], undefined);
});
test('Scan library excludes unrelated folders and disposed or stale selections cannot register', async (t) => {
  const f = folderFixture(t);
  f.roots.push(
    { id: 'mine', path: '/mine', label: 'Mine', libraryId: 'library', createdAt: '' },
    { id: 'other', path: '/other', label: 'Other', libraryId: 'other', createdAt: '' },
  );
  const folders = createLibraryFolders(f.client, f.context);
  await folders.load({ libraryId: 'library' });
  await folders.scanLibrary();
  assert.deepEqual(
    f.calls.filter((c) => c.path.endsWith('/scan')).map((c) => c.path),
    ['/api/v1/roots/mine/scan'],
  );
  assert.equal(await folders.add({ ...selection(), origin: 'http://other.test' }), false);
  folders.dispose();
  assert.equal(await folders.add(selection()), false);
  assert.equal(f.roots.length, 2);
});
test('registration errors retain input and pending duplicate submissions are ignored', async (t) => {
  const f = folderFixture(t);
  const folders = createLibraryFolders(f.client, f.context);
  await folders.load({ libraryId: 'library' });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.override(async (path) => {
    if (!path.endsWith('/roots')) return null;
    await held;
    return Response.json({ title: 'Unavailable path' }, { status: 400 });
  });
  const pending = folders.add(selection());
  await Promise.resolve();
  assert.equal(await folders.add(selection()), false);
  release();
  assert.equal(await pending, false);
  assert.match(get(folders).failure ?? '', /Unavailable path/);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
});

test('owner rejection clears private folders and blocks further mutation', async (t) => {
  const f = folderFixture(t);
  const rejected: number[] = [];
  const folders = createLibraryFolders(f.client, {
    ...f.context,
    onrejected: (status) => {
      rejected.push(status);
    },
  });
  await folders.load({ libraryId: 'library' });
  await folders.add(selection());
  f.override(async (path) =>
    path.endsWith('/scan') ? Response.json({ title: 'Denied' }, { status: 401 }) : null,
  );
  await folders.retryScan('root-0');
  assert.deepEqual(rejected, [401]);
  assert.deepEqual(get(folders).summaries, []);
  assert.equal(await folders.add(selection('/other')), false);
  assert.equal(f.roots.length, 1);
});

test('an older summary read cannot erase a committed root while its scan and new refresh fail', async (t) => {
  const f = folderFixture(t);
  const folders = createLibraryFolders(f.client, f.context);
  await folders.load({ libraryId: 'library' });
  let releaseRead = () => {};
  const heldRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let releaseScan = () => {};
  const heldScan = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  let scanning = () => {};
  const startedScan = new Promise<void>((resolve) => {
    scanning = resolve;
  });
  let reads = 0;
  f.override(async (path) => {
    if (path.endsWith('/root-summaries')) {
      if (++reads === 1) {
        await heldRead;
        return Response.json({ items: [] });
      }
      return Response.json({ title: 'Offline' }, { status: 503 });
    }
    if (path.endsWith('/scan')) {
      scanning();
      await heldScan;
      return Response.json({ title: 'Offline' }, { status: 503 });
    }
    return null;
  });
  const oldRead = folders.load({ libraryId: 'library' });
  const adding = folders.add(selection());
  await startedScan;
  releaseRead();
  await oldRead;
  releaseScan();
  await adding;
  assert.equal(get(folders).summaries[0]?.root.id, 'root-0');
  assert.equal(f.roots.length, 1);
});

test('a delayed parent cache cannot erase a committed folder or disable its scan retry after failed followups', async (t) => {
  const f = folderFixture(t);
  const folders = createLibraryFolders(f.client, {
    ...f.context,
    onchanged: () => {
      throw new Error('Discovery unavailable');
    },
  });
  await folders.load({ libraryId: 'library' });
  f.override(async (path) =>
    path.endsWith('/scan') || path.endsWith('/root-summaries')
      ? Response.json({ title: 'Offline' }, { status: 503 })
      : null,
  );
  assert.equal(await folders.add(selection()), true);
  assert.equal(get(folders).summaries[0]?.root.id, 'root-0');
  assert.match(get(folders).scanFailures['root-0'] ?? '', /Offline/);
  // SettingsLibraries began this cached read before the registration committed.
  folders.receive([]);
  assert.equal(get(folders).summaries[0]?.root.id, 'root-0');
  assert.match(get(folders).scanFailures['root-0'] ?? '', /Offline/);
  f.override(null);
  await folders.retryScan('root-0');
  assert.equal(f.calls.filter((call) => call.path.endsWith('/scan')).length, 2);
  assert.equal(f.roots.length, 1);
  assert.equal(get(folders).scanFailures['root-0'], undefined);
  // A successful local read does not order a delayed parent cache receive.
  folders.receive([]);
  assert.equal(get(folders).summaries[0]?.root.id, 'root-0');
  // A genuine post-mutation server read proving absence still removes the row.
  f.roots.splice(0);
  await folders.load({ libraryId: 'library' });
  assert.equal(get(folders).summaries.length, 0);
});

test('a successful local summary cannot acknowledge an older parent cache after scan and discovery failure', async (t) => {
  const f = folderFixture(t);
  const folders = createLibraryFolders(f.client, {
    ...f.context,
    onchanged: () => {
      throw new Error('Discovery unavailable');
    },
  });
  await folders.load({ libraryId: 'library' });
  f.override(async (path) =>
    path.endsWith('/scan') ? Response.json({ title: 'Scan offline' }, { status: 503 }) : null,
  );
  assert.equal(await folders.add(selection()), true);
  assert.equal(get(folders).summaries[0]?.root.id, 'root-0');
  assert.match(get(folders).scanFailures['root-0'] ?? '', /Scan offline/);
  folders.receive([]);
  assert.equal(get(folders).summaries[0]?.root.id, 'root-0');
  assert.match(get(folders).scanFailures['root-0'] ?? '', /Scan offline/);
  f.override(null);
  await folders.retryScan('root-0');
  assert.equal(f.calls.filter((call) => call.path.endsWith('/scan')).length, 2);
  assert.equal(f.roots.length, 1);
  assert.equal(get(folders).scanFailures['root-0'], undefined);
  // Seeing this committed ID in the parent's own response acknowledges its ordering.
  folders.receive([...get(folders).summaries]);
  folders.receive([]);
  assert.equal(get(folders).summaries.length, 0);
});
