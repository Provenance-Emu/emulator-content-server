import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import { createLibraryBrowser } from '../src/lib/library-browser.js';
import { entry, problem, transport } from './library-browser-fixture.js';
import { deferred } from './lifecycle-fixture.js';

test('switching from multiple systems to a single system clears the previous selection and cursor', async (t) => {
  const f = transport(() => Response.json({ items: [entry()], nextCursor: 'next' }));
  t.after(f.restore);
  const browser = createLibraryBrowser(f.client, { libraryId: 'library' });
  t.after(() => browser.dispose());
  await browser.setQuery({ systemIds: ['com.provenance.nes', 'unknown'] });
  await browser.more();
  await browser.setQuery({ systemId: 'com.provenance.snes' });
  const query = f.requests.at(-1)?.searchParams;
  assert.equal(query?.get('systemId'), 'com.provenance.snes');
  assert.equal(query?.has('systemIds'), false);
  assert.equal(query?.has('cursor'), false);
  assert.deepEqual(get(browser).filters.systemIds, []);
  await browser.setQuery({ systemId: '' });
  assert.equal(f.requests.at(-1)?.searchParams.has('systemId'), false);
});

test('120 tied mixed identities accumulate in bounded batches, keep their identity, and are re-read together', async (t) => {
  const rows = Array.from({ length: 120 }, (_, i) =>
    entry(['item', 'asset', 'source'][i % 3], String(Math.floor(i / 3))),
  );
  const f = transport((url) => {
    assert.equal(url.pathname, '/api/v1/browse');
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    assert.equal(url.searchParams.get('limit'), '50');
    return Response.json({
      items: rows.slice(offset, offset + 50),
      nextCursor: offset + 50 < 120 ? String(offset + 50) : null,
    });
  });
  t.after(f.restore);
  const browser = createLibraryBrowser(f.client, { libraryId: 'library' });
  t.after(() => browser.dispose());
  await browser.refresh();
  assert.equal(get(browser).items.length, 50);
  assert.equal(get(browser).hasMore, true);
  const first = get(browser).items[0];
  await browser.more();
  assert.equal(get(browser).items.length, 100);
  assert.equal(get(browser).items[0], first);
  await browser.more();
  const seen = get(browser).items.map((r) => `${r.entityType}:${r.id}`);
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120);
  assert.equal(get(browser).hasMore, false);
  const count = f.requests.length;
  await browser.more();
  assert.equal(f.requests.length, count);
  await browser.refresh();
  assert.deepEqual(
    f.requests.slice(count).map((request) => request.searchParams.get('cursor')),
    [null, '50', '100'],
  );
  assert.equal(get(browser).items.length, 120);
  assert.equal(get(browser).hasMore, false);
});

test('a row that moves between two reads is listed once', async (t) => {
  const f = transport((url) =>
    Response.json(
      url.searchParams.has('cursor')
        ? { items: [entry('source', 'b'), entry('source', 'c')], nextCursor: null }
        : { items: [entry('source', 'a'), entry('source', 'b')], nextCursor: 'next' },
    ),
  );
  t.after(f.restore);
  const browser = createLibraryBrowser(f.client, { libraryId: 'library' });
  t.after(() => browser.dispose());
  await browser.refresh();
  await browser.more();
  assert.deepEqual(
    get(browser).items.map((row) => row.id),
    ['a', 'b', 'c'],
  );
  await browser.refresh();
  assert.deepEqual(
    get(browser).items.map((row) => row.id),
    ['a', 'b', 'c'],
  );
});

test('all filters reset cursor; view stays client-side; detail back preserves the list, query, scroll and discriminated focus', async (t) => {
  const f = transport(() =>
    Response.json({ items: [entry('source', 'same'), entry('item', 'same')], nextCursor: 'page2' }),
  );
  t.after(f.restore);
  const b = createLibraryBrowser(f.client, { libraryId: 'library' });
  t.after(() => b.dispose());
  await b.refresh();
  await b.more();
  await b.setQuery({
    category: 'media',
    search: 'same & title',
    systemId: 'unknown',
    rootId: 'root',
    sort: 'name_desc',
    view: 'list',
  });
  const q = f.requests.at(-1)?.searchParams;
  assert.equal(q?.get('cursor'), null);
  assert.equal(q?.get('category'), 'media');
  assert.equal(q?.get('systemId'), 'unknown');
  assert.equal(q?.get('rootId'), 'root');
  assert.equal(q?.get('sort'), 'name_desc');
  assert.equal(q?.get('search'), 'same & title');
  assert.equal(q?.get('view'), null);
  const count = f.requests.length;
  await b.setQuery({ view: 'grid' });
  assert.equal(f.requests.length, count);
  await b.more();
  const selected = get(b).items[1];
  assert.ok(selected);
  b.open(selected, { scrollTop: 987, focusKey: 'item:same' });
  assert.equal(get(b).active?.entityType, 'item');
  assert.deepEqual(b.back(), { scrollTop: 987, focusKey: 'item:same' });
  assert.equal(get(b).items.length, 2);
  assert.equal(get(b).filters.search, 'same & title');
  await b.selectScope({ unassigned: true });
  assert.equal(f.requests.at(-1)?.searchParams.has('cursor'), false);
  assert.equal(get(b).filters.search, '');
  assert.equal(get(b).filters.systemId, '');
  assert.equal(f.requests.at(-1)?.searchParams.get('unassigned'), 'true');
  await b.selectScope(null);
  assert.deepEqual(get(b).items, []);
  assert.equal(get(b).active, null);
});

test('transient refresh retains the list but denied and invalid-cursor responses clear private bodies and require explicit restart', async (t) => {
  let response = () => Response.json({ items: [entry()], nextCursor: 'page2' });
  const f = transport(() => response());
  t.after(f.restore);
  const b = createLibraryBrowser(f.client, { libraryId: 'library' });
  t.after(() => b.dispose());
  await b.refresh();
  await b.more();
  response = () => problem(503);
  await b.refresh();
  assert.equal(get(b).items.length, 1);
  assert.equal(get(b).hasMore, true);
  response = () => problem(400, 'invalid-cursor');
  await b.refresh();
  assert.deepEqual(get(b).items, []);
  assert.equal(get(b).requiresRefresh, true);
  const n = f.requests.length;
  await b.refresh();
  await b.more();
  assert.equal(f.requests.length, n);
  response = () => Response.json({ items: [entry()], nextCursor: null });
  await b.refresh({ restart: true });
  assert.equal(get(b).hasMore, false);
  assert.equal(get(b).items.length, 1);
  for (const status of [401, 403, 404]) {
    response = () => problem(status);
    await b.refresh();
    assert.deepEqual(get(b).items, []);
    assert.equal(get(b).active, null);
    assert.equal(get(b).status, status);
    response = () => Response.json({ items: [entry()], nextCursor: null });
    await b.refresh();
  }
});

test('scope changes and disposal defeat deferred refreshes; concurrent invalidations coalesce', async (t) => {
  const pending = deferred<Response>();
  let delay = false;
  const f = transport(() =>
    delay ? pending.promise : Response.json({ items: [entry()], nextCursor: null }),
  );
  t.after(f.restore);
  const b = createLibraryBrowser(f.client, { libraryId: 'library' });
  await b.refresh();
  delay = true;
  const a = b.refresh();
  const duplicate = b.refresh();
  assert.equal(f.requests.length, 2);
  await b.selectScope(null);
  pending.resolve(Response.json({ items: [entry()], nextCursor: null }));
  await Promise.all([a, duplicate]);
  assert.deepEqual(get(b).items, []);
  const late = deferred<Response>();
  const g = transport(() => late.promise);
  t.after(g.restore);
  const old = createLibraryBrowser(g.client, { libraryId: 'library' });
  const read = old.refresh();
  old.dispose();
  late.resolve(Response.json({ items: [entry()], nextCursor: null }));
  await read;
  assert.deepEqual(get(old).items, []);
  assert.equal(get(old).scope, null);
});

test('refresh revalidates the list during detail, updates source metadata and clears moved/revoked selection', async (t) => {
  let rows = [entry('source', 'source')];
  let more: string | null = 'second';
  const f = transport(() => Response.json({ items: rows, nextCursor: more }));
  t.after(f.restore);
  const b = createLibraryBrowser(f.client, { libraryId: 'library' });
  t.after(() => b.dispose());
  await b.refresh();
  await b.more();
  const selected = rows[0];
  assert.ok(selected?.source);
  b.open(selected, { scrollTop: 50, focusKey: 'source:source' });
  rows = [
    { ...entry('source', 'source'), source: { ...selected.source, availability: 'offline' } },
  ];
  await b.refresh();
  assert.equal(f.requests.at(-1)?.searchParams.get('cursor'), 'second');
  assert.equal(get(b).active?.source?.availability, 'offline');
  assert.equal(get(b).items.length, 1);
  // The whole list was read and the game is not in it: it is gone, so its page closes.
  rows = [];
  more = null;
  await b.refresh();
  assert.equal(get(b).active, null);
  assert.deepEqual(get(b).items, []);
});

test('a game that sorts further down after a rename stays open, and is picked up fresh when it is near', async (t) => {
  let names = Array.from({ length: 400 }, (_, i) => `row-${String(i).padStart(3, '0')}`);
  const f = transport((url) => {
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    return Response.json({
      items: names.slice(offset, offset + 50).map((id) => entry('source', id)),
      nextCursor: offset + 50 < names.length ? String(offset + 50) : null,
    });
  });
  t.after(f.restore);
  const b = createLibraryBrowser(f.client, { libraryId: 'library' });
  t.after(() => b.dispose());
  await b.refresh();
  const opened = get(b).items[0];
  assert.ok(opened, get(b).failure ?? 'nothing was read');
  b.open(opened, { scrollTop: 0, focusKey: 'source:row-000' });

  // Renamed so it now sorts just past the first batch: found by reading a little further.
  names = [...names.slice(1, 61), 'row-000', ...names.slice(61)];
  await b.refresh();
  assert.equal(get(b).active?.id, 'row-000');
  assert.notEqual(get(b).active, opened);
  assert.equal(get(b).items.length, 100);

  // Renamed so it sorts at the very end: not searched for forever, and still open.
  names = [...names.filter((id) => id !== 'row-000'), 'row-000'];
  const before = f.requests.length;
  const kept = get(b).active;
  await b.refresh();
  assert.equal(f.requests.length - before, 5);
  assert.equal(get(b).active, kept);
  assert.equal(get(b).hasMore, true);
});

test('multi-system selection resets paging, preserves full-scope counts and clears together', async (t) => {
  const f = transport(() =>
    Response.json({
      items: [],
      nextCursor: null,
      systemCounts: [
        { systemId: 'com.provenance.nes', count: 101 },
        { systemId: 'unknown', count: 2 },
      ],
    }),
  );
  t.after(f.restore);
  const b = createLibraryBrowser(f.client, { libraryId: 'library' });
  t.after(() => b.dispose());
  await b.refresh();
  await b.setQuery({ systemIds: ['com.provenance.nes', 'unknown'] } as Partial<
    import('../src/lib/library-browser.js').BrowseFilters
  >);
  assert.equal(f.requests.at(-1)?.searchParams.get('systemIds'), 'com.provenance.nes,unknown');
  assert.deepEqual((get(b) as unknown as { systemCounts: unknown }).systemCounts, [
    { systemId: 'com.provenance.nes', count: 101 },
    { systemId: 'unknown', count: 2 },
  ]);
  await b.setQuery({ systemIds: [] } as Partial<
    import('../src/lib/library-browser.js').BrowseFilters
  >);
  assert.equal(f.requests.at(-1)?.searchParams.has('systemIds'), false);
});
