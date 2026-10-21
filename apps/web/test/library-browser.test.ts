import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import { createLibraryBrowser } from '../src/lib/library-browser.js';
import { entry, problem, transport } from './library-browser-fixture.js';
import { deferred } from './lifecycle-fixture.js';

test('120 tied mixed identities are reachable in bounded pages with previous history and no manifests', async (t) => {
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
  const seen = get(browser).items.map((r) => `${r.entityType}:${r.id}`);
  assert.equal(seen.length, 50);
  await browser.next();
  seen.push(...get(browser).items.map((r) => `${r.entityType}:${r.id}`));
  await browser.next();
  seen.push(...get(browser).items.map((r) => `${r.entityType}:${r.id}`));
  assert.equal(new Set(seen).size, 120);
  assert.equal(get(browser).hasNext, false);
  assert.equal(get(browser).page, 3);
  await browser.previous();
  assert.equal(get(browser).items[0]?.id, '16');
  assert.equal(get(browser).items[0]?.entityType, 'source');
  assert.equal(get(browser).page, 2);
  await browser.refresh();
  assert.equal(f.requests.at(-1)?.searchParams.get('cursor'), '50');
  assert.equal(get(browser).page, 2);
});

test('all filters reset cursor; view stays client-side; detail back preserves page query scroll and discriminated focus', async (t) => {
  const f = transport(() =>
    Response.json({ items: [entry('source', 'same'), entry('item', 'same')], nextCursor: 'page2' }),
  );
  t.after(f.restore);
  const b = createLibraryBrowser(f.client, { libraryId: 'library' });
  t.after(() => b.dispose());
  await b.refresh();
  await b.next();
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
  await b.next();
  const selected = get(b).items[1];
  assert.ok(selected);
  b.open(selected, { scrollTop: 987, focusKey: 'item:same' });
  assert.equal(get(b).active?.entityType, 'item');
  assert.deepEqual(b.back(), { scrollTop: 987, focusKey: 'item:same' });
  assert.equal(get(b).page, 2);
  assert.equal(get(b).filters.search, 'same & title');
  await b.selectScope({ unassigned: true });
  assert.equal(get(b).page, 1);
  assert.equal(get(b).filters.search, '');
  assert.equal(get(b).filters.systemId, '');
  assert.equal(f.requests.at(-1)?.searchParams.get('unassigned'), 'true');
  await b.selectScope(null);
  assert.deepEqual(get(b).items, []);
  assert.equal(get(b).active, null);
});

test('transient refresh retains page but denied and invalid-cursor responses clear private bodies and require explicit restart', async (t) => {
  let response = () => Response.json({ items: [entry()], nextCursor: 'page2' });
  const f = transport(() => response());
  t.after(f.restore);
  const b = createLibraryBrowser(f.client, { libraryId: 'library' });
  t.after(() => b.dispose());
  await b.refresh();
  await b.next();
  response = () => problem(503);
  await b.refresh();
  assert.equal(get(b).items.length, 1);
  assert.equal(get(b).page, 2);
  response = () => problem(400, 'invalid-cursor');
  await b.refresh();
  assert.deepEqual(get(b).items, []);
  assert.equal(get(b).requiresRefresh, true);
  const n = f.requests.length;
  await b.refresh();
  await b.next();
  assert.equal(f.requests.length, n);
  response = () => Response.json({ items: [entry()], nextCursor: null });
  await b.refresh({ restart: true });
  assert.equal(get(b).page, 1);
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

test('refresh revalidates the return page during detail, updates source metadata and clears moved/revoked selection', async (t) => {
  let rows = [entry('source', 'source')];
  const f = transport(() => Response.json({ items: rows, nextCursor: 'second' }));
  t.after(f.restore);
  const b = createLibraryBrowser(f.client, { libraryId: 'library' });
  t.after(() => b.dispose());
  await b.refresh();
  await b.next();
  const selected = rows[0];
  assert.ok(selected?.source);
  b.open(selected, { scrollTop: 50, focusKey: 'source:source' });
  rows = [
    { ...entry('source', 'source'), source: { ...selected.source, availability: 'offline' } },
  ];
  await b.refresh();
  assert.equal(f.requests.at(-1)?.searchParams.get('cursor'), 'second');
  assert.equal(get(b).active?.source?.availability, 'offline');
  assert.equal(get(b).page, 2);
  rows = [];
  await b.refresh();
  assert.equal(get(b).active, null);
  assert.deepEqual(get(b).items, []);
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
