import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import { createUploadQueue } from '../src/lib/upload-queue.js';
import { createUploadReview } from '../src/lib/upload-review.js';
import { asset, item, problem, transport } from './library-browser-fixture.js';
import { deferred } from './lifecycle-fixture.js';

function entries(target = false) {
  const review = createUploadReview({
    libraryId: 'library',
    item: target ? item() : null,
    systems: [{ identifier: 'com.provenance.nes', name: 'NES' }],
  });
  review.selectFiles([
    new File([new Uint8Array(5)], 'one.nes'),
    new File([new Uint8Array(5)], 'two.nes'),
  ]);
  if (target) review.setCommonMetadata({ kind: 'battery_save' });
  return review.validate() ?? [];
}
test('sequential queue retains created items, request baselines and keys across completion loss; successes never retry', async (t) => {
  let creates = 0;
  let loss = true;
  let revision = 7;
  const keys: string[] = [];
  const bases: number[] = [];
  const f = transport((url, init) => {
    if (url.pathname === '/api/v1/items') return Response.json(item(`created-${++creates}`));
    if (url.pathname === '/api/v1/uploads') {
      keys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      return Response.json({ id: 'session' });
    }
    if (url.pathname.endsWith('/session'))
      return Response.json({ id: 'session', state: 'open', received: 0 });
    if (url.pathname.endsWith('/content')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/complete')) {
      const body = JSON.parse(String(init?.body));
      bases.push(body.baseRevision);
      revision++;
      if (loss && body.itemId === 'created-1') throw new TypeError('Lost response');
      return Response.json(asset());
    }
    if (url.pathname.endsWith('/manifest'))
      return Response.json({ itemId: 'item', revision, files: [], version: 1 });
    throw new Error(url.pathname);
  });
  t.after(f.restore);
  const q = createUploadQueue(f.client, { libraryId: 'library' });
  await q.start(entries());
  assert.deepEqual(
    get(q).entries.map((e) => e.state),
    ['failed', 'succeeded'],
  );
  const firstKey = keys[0];
  loss = false;
  await q.retryUnfinished();
  assert.deepEqual(
    get(q).entries.map((e) => e.state),
    ['succeeded', 'succeeded'],
  );
  assert.equal(creates, 2);
  assert.equal(keys.length, 3);
  assert.equal(keys[2], firstKey);
  assert.ok(bases.every((b) => b === 7));
});
test('subsequent associated uploads refresh revisions while failed entries retain their original save baseline', async (t) => {
  let manifests = 0;
  const bases: number[] = [];
  let fail = true;
  const f = transport((url, init) => {
    if (url.pathname.endsWith('/manifest')) {
      manifests++;
      return Response.json({ itemId: 'item', revision: 8, files: [], version: 1 });
    }
    if (url.pathname === '/api/v1/uploads') return Response.json({ id: 'session' });
    if (url.pathname.endsWith('/session'))
      return Response.json({ id: 'session', state: 'open', received: 0 });
    if (url.pathname.endsWith('/content')) return new Response(null, { status: 204 });
    bases.push(JSON.parse(String(init?.body)).baseRevision);
    if (fail && bases.length === 1) return problem(400);
    return Response.json(asset());
  });
  t.after(f.restore);
  const q = createUploadQueue(f.client, { libraryId: 'library' });
  await q.start(entries(true));
  fail = false;
  await q.retryUnfinished();
  assert.deepEqual(bases, [7, 8, 7]);
  assert.equal(manifests, 1);
});
test('stop after current and disposal schedule no later files and suppress late progress', async (t) => {
  const held = deferred<Response>();
  let opens = 0;
  const f = transport((url) => {
    if (url.pathname === '/api/v1/uploads') {
      opens++;
      return Response.json({ id: 'session' });
    }
    if (url.pathname.endsWith('/session'))
      return Response.json({ id: 'session', state: 'open', received: 0 });
    if (url.pathname.endsWith('/content')) return held.promise;
    return Response.json(asset());
  });
  t.after(f.restore);
  const q = createUploadQueue(f.client, { libraryId: 'library' });
  const running = q.start(entries(true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  q.stopAfterCurrent();
  held.resolve(new Response(null, { status: 204 }));
  await running;
  assert.equal(opens, 1);
  assert.deepEqual(
    get(q).entries.map((e) => e.state),
    ['succeeded', 'waiting'],
  );
  const r = createUploadQueue(f.client, { libraryId: 'library' });
  let updates = 0;
  r.subscribe(() => updates++);
  const second = r.start(entries(true));
  r.dispose();
  const before = updates;
  await second;
  assert.equal(updates, before);
});
test('authorization loss stops the queue and unknown item creation requires an explicit reconciliation target', async (t) => {
  let creates = 0;
  let unauthorized = false;
  const f = transport((url) => {
    if (url.pathname === '/api/v1/items') {
      creates++;
      throw new TypeError('Unknown create');
    }
    if (unauthorized) return problem(401);
    return Response.json({ id: 'session' });
  });
  t.after(f.restore);
  const q = createUploadQueue(f.client, { libraryId: 'library' });
  await q.start(entries());
  await q.retryUnfinished();
  assert.equal(creates, 2);
  assert.ok(get(q).entries.every((e) => e.state === 'reconciliation-required'));
  const first = get(q).entries[0];
  assert.ok(first);
  q.reconcile(first.id, item());
  unauthorized = true;
  await q.retryUnfinished();
  assert.equal(get(q).status, 401);
  assert.equal(get(q).entries[1]?.state, 'reconciliation-required');
  assert.equal(creates, 2);
});

test('interrupted chunks resume from the server offset with visible progress and four MiB pieces', async (t) => {
  const starts: number[] = [];
  let received = 0;
  let interrupted = false;
  const f = transport((url, init) => {
    if (url.pathname === '/api/v1/uploads') return Response.json({ id: 'session' });
    if (url.pathname.endsWith('/session'))
      return Response.json({ id: 'session', state: 'open', received });
    if (url.pathname.endsWith('/content')) {
      const range = new Headers(init?.headers).get('content-range') ?? '';
      const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      assert.ok(match);
      starts.push(Number(match[1]));
      received = Number(match[2]) + 1;
      if (received === 8 * 1024 * 1024 && !interrupted) {
        interrupted = true;
        throw new TypeError('Lost chunk response');
      }
      return new Response(null, { status: 204 });
    }
    return Response.json(asset());
  });
  t.after(f.restore);
  const review = createUploadReview({ libraryId: 'library', item: item(), systems: [] });
  review.selectFiles([new File([new Uint8Array(9 * 1024 * 1024)], 'large.sav')]);
  const q = createUploadQueue(f.client, { libraryId: 'library' });
  const progress: number[] = [];
  q.subscribe((s) => {
    if (s.entries[0]) progress.push(s.entries[0].sent);
  });
  await q.start(review.validate() ?? []);
  assert.deepEqual(starts, [0, 4194304, 8388608]);
  assert.ok(progress.includes(4194304));
  assert.ok(progress.includes(8388608));
  assert.equal(get(q).entries[0]?.state, 'succeeded');
});

test('disposal leaves the last published snapshot untouched after a delayed item creation', async (t) => {
  const created = deferred<Response>();
  const f = transport((url) => {
    assert.equal(url.pathname, '/api/v1/items');
    return created.promise;
  });
  t.after(f.restore);
  const q = createUploadQueue(f.client, { libraryId: 'library' });
  const running = q.start(entries());
  const snapshot = get(q);
  q.dispose();
  created.resolve(Response.json(item('late')));
  await running;
  assert.equal(snapshot.entries[0]?.target, null);
  assert.equal(get(q).entries[0]?.target, null);
});
