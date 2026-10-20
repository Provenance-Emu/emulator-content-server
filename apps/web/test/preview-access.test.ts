import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import { createApplication } from '../src/lib/application.js';
import { createDetail } from '../src/lib/detail.js';
import { createLibraryBrowser } from '../src/lib/library-browser.js';
import { createPreviews } from '../src/lib/previews.js';
import { asset, entry, problem } from './library-browser-fixture.js';
import { deferred, serverFixture } from './lifecycle-fixture.js';

function artwork() {
  return {
    ...entry('item', 'item'),
    previewAsset: { ...asset('art', 'artwork'), conflictOf: null },
  };
}

test('preview 401 can synchronously clear application collection and detail through its public authorization callback', async (t) => {
  const f = serverFixture();
  t.after(f.restore);
  f.logoutStatus = 503;
  const delegate = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/browse')
      return Response.json({ items: [artwork(), entry('source', 'source')], nextCursor: null });
    if (url.pathname === '/api/v1/files/art/content') return problem(401);
    return delegate(input, init);
  };
  const application = createApplication(f.context, f.scheduler);
  t.after(() => application.dispose());
  await application.start();
  const browser = createLibraryBrowser(f.context.client, { libraryId: 'library' });
  t.after(() => browser.dispose());
  await browser.refresh();
  const selected = get(browser).items[1];
  assert.ok(selected);
  browser.open(selected, { scrollTop: 10, focusKey: 'source:source' });
  const detail = createDetail(f.context.client, selected);
  t.after(() => detail.dispose());
  await detail.load();
  assert.equal(get(application).signedIn, true);
  assert.equal(get(detail).source?.id, 'source');
  let revoking: Promise<void> | null = null;
  const previews = createPreviews(f.context.client, {
    authorizationRejected(status) {
      assert.equal(status, 401);
      // Task3c's auth-loss branch. signOut forgets synchronously before awaiting HTTP.
      revoking = application.signOut();
      browser.dispose();
      detail.dispose();
      previews.dispose();
    },
  });
  t.after(() => previews.dispose());
  await previews.setPage(get(browser).items);
  assert.equal(get(application).signedIn, false);
  assert.deepEqual(get(application).libraries, []);
  assert.deepEqual(get(browser).items, []);
  assert.equal(get(browser).active, null);
  assert.equal(get(detail).source, null);
  assert.deepEqual(get(previews).urls, {});
  await revoking;
  assert.equal(get(application).signedIn, false);
});

test('preview 403 clears only its view and revalidates the saved bounded page while superseding an older pending read', async (t) => {
  const f = serverFixture();
  t.after(f.restore);
  const delegate = globalThis.fetch;
  const old = deferred<Response>();
  const revalidated = deferred<Response>();
  const browseRequests: URL[] = [];
  let phase = 'normal';
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/browse') {
      browseRequests.push(url);
      if (phase === 'old') return old.promise;
      if (phase === 'revalidate') return revalidated.promise;
      return Response.json({ items: [artwork(), entry('source', 'source')], nextCursor: 'next' });
    }
    if (url.pathname === '/api/v1/files/art/content') return problem(403);
    return delegate(input, init);
  };
  const application = createApplication(f.context, f.scheduler);
  t.after(() => application.dispose());
  await application.start();
  const browser = createLibraryBrowser(f.context.client, { libraryId: 'library' });
  t.after(() => browser.dispose());
  await browser.refresh();
  await browser.setQuery({
    search: 'Same',
    rootId: 'root',
    systemId: 'com.provenance.nes',
    sort: 'name_desc',
    view: 'list',
  });
  await browser.next();
  const filters = get(browser).filters;
  const selected = get(browser).items[1];
  assert.ok(selected);
  browser.open(selected, { scrollTop: 10, focusKey: 'source:source' });
  const detail = createDetail(f.context.client, selected);
  t.after(() => detail.dispose());
  await detail.load();
  phase = 'old';
  const oldRead = browser.refresh();
  let refresh: Promise<void> | null = null;
  const previews = createPreviews(f.context.client, {
    authorizationRejected(status) {
      assert.equal(status, 403);
      phase = 'revalidate';
      detail.dispose();
      refresh = browser.refresh({ clear: true });
    },
  });
  t.after(() => previews.dispose());
  await previews.setPage(get(browser).items);
  assert.deepEqual(get(browser).items, []);
  assert.equal(get(browser).active, null);
  assert.equal(get(detail).source, null);
  assert.equal(get(application).signedIn, true);
  assert.deepEqual(get(browser).filters, filters);
  assert.deepEqual(get(browser).scope, { libraryId: 'library' });
  assert.equal(get(browser).page, 2);
  assert.equal(browseRequests.length, 5);
  assert.equal(browseRequests.at(-1)?.searchParams.get('cursor'), 'next');
  assert.equal(browseRequests.at(-1)?.searchParams.get('limit'), '50');
  assert.equal(browseRequests.at(-1)?.searchParams.get('search'), 'Same');
  old.resolve(Response.json({ items: [entry('source', 'private-old')], nextCursor: 'old-next' }));
  await oldRead;
  assert.deepEqual(get(browser).items, []);
  revalidated.resolve(Response.json({ items: [entry('item', 'authorized')], nextCursor: null }));
  await refresh;
  assert.deepEqual(
    get(browser).items.map((row) => row.id),
    ['authorized'],
  );
  assert.equal(get(browser).page, 2);
  assert.equal(get(browser).hasPrevious, true);
  assert.deepEqual(get(browser).filters, filters);
  assert.equal(
    f.requests.some((request) => request.path === '/api/v1/auth/logout'),
    false,
  );
});
