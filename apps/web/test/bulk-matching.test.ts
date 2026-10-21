import assert from 'node:assert/strict';
import test from 'node:test';
import type { MatchingCandidate, SavedSourceMatch } from '@ecs/client';
import { get } from 'svelte/store';
import { createBulkMatching } from '../src/lib/bulk-matching.js';
import { entry, problem, transport } from './library-browser-fixture.js';
import { deferred } from './lifecycle-fixture.js';

const candidate = (id: string, kind = 'metadata', confidence = 'checksum'): MatchingCandidate => ({
  id,
  kind,
  confidence,
  providerId: 'test.provider',
  title: 'Verified Game',
  metadata: { title: 'Verified Game', systemId: 'com.provenance.nes' },
});
const selected = (c: MatchingCandidate): SavedSourceMatch => ({
  ...c,
  contentAvailable: false,
  contentType: null,
  fileName: null,
  updatedAt: '',
});

test('retry includes partial provider failures without rerunning healthy games or replacing saved choices', async (t) => {
  let failing = true;
  const lookups: string[] = [];
  const writes: string[] = [];
  const preserved = selected(candidate('original', 'rom'));
  const choices = [preserved];
  const f = transport((url, init) => {
    if (url.pathname === '/api/v1/browse')
      return Response.json({
        items: [entry('source', 'partial'), entry('source', 'healthy')],
        nextCursor: null,
      });
    const id = url.pathname.split('/')[4] ?? '';
    if (url.pathname.endsWith('/selections')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        assert.equal(body.expectedRevision, 1);
        writes.push(body.candidateId);
        choices.push(selected(candidate(body.candidateId)));
      }
      return Response.json({ sourceId: id, revision: choices.length, matches: choices });
    }
    lookups.push(id);
    return Response.json({
      sourceId: id,
      requestId: 'request',
      plugins: [],
      candidates:
        id === 'partial' ? [candidate('new-metadata'), candidate('replacement', 'rom')] : [],
      problems:
        id === 'partial' && failing
          ? [{ providerId: 'broken.provider', code: 'provider-failed' }]
          : [],
    });
  });
  t.after(f.restore);
  const bulk = createBulkMatching(f.client);
  t.after(() => bulk.dispose());
  await bulk.start({ libraryId: 'library' }, {});
  assert.equal(get(bulk).rows[0]?.status, 'review');
  assert.equal(get(bulk).rows[0]?.retryable, true);
  assert.deepEqual(writes, []);
  failing = false;
  await bulk.retryFailures();
  assert.deepEqual(lookups, ['partial', 'healthy', 'partial']);
  assert.deepEqual(writes, ['new-metadata']);
  assert.equal(choices[0], preserved);
  assert.equal(get(bulk).rows[0]?.status, 'saved');
  assert.equal(get(bulk).rows[0]?.retryable, false);
  await bulk.retryFailures();
  assert.deepEqual(lookups, ['partial', 'healthy', 'partial']);
});

test('finishing review removes a partial provider failure from the retry queue', async (t) => {
  const f = transport((url) => {
    if (url.pathname === '/api/v1/browse')
      return Response.json({ items: [entry('source', 'partial')], nextCursor: null });
    if (url.pathname.endsWith('/selections'))
      return Response.json({ sourceId: 'partial', revision: 0, matches: [] });
    return Response.json({
      sourceId: 'partial',
      requestId: 'request',
      plugins: [],
      candidates: [],
      problems: [{ providerId: 'broken.provider', code: 'provider-failed' }],
    });
  });
  t.after(f.restore);
  const bulk = createBulkMatching(f.client);
  t.after(() => bulk.dispose());
  await bulk.start({ libraryId: 'library' }, {});
  assert.equal(get(bulk).rows[0]?.retryable, true);
  bulk.reviewed('partial');
  assert.equal(get(bulk).rows[0]?.retryable, false);
  const requests = f.requests.length;
  await bulk.retryFailures();
  assert.equal(f.requests.length, requests);
  assert.equal(get(bulk).rows[0]?.status, 'reviewed');
});

test('bulk matching snapshots every library page before writes, saves unique checksums, and preserves choices', async (t) => {
  let enumerated = false;
  const writes: { id: string; revision: number }[] = [];
  const choices = new Map<string, SavedSourceMatch[]>([
    ['preserved', [selected(candidate('old'))]],
  ]);
  const rows = ['exact', 'ambiguous', 'preserved', 'hint', 'partial', 'empty'].map((id) =>
    entry('source', id),
  );
  const f = transport((url, init) => {
    if (url.pathname === '/api/v1/browse') {
      assert.equal(url.searchParams.get('libraryId'), 'library');
      assert.equal(url.searchParams.get('category'), 'games');
      if (!url.searchParams.has('cursor'))
        return Response.json({ items: rows.slice(0, 3), nextCursor: 'second' });
      assert.equal(writes.length, 0, 'writes would invalidate title-sorted pagination');
      enumerated = true;
      return Response.json({ items: rows.slice(3), nextCursor: null });
    }
    assert.equal(enumerated, true);
    const id = url.pathname.split('/')[4] ?? '';
    const saved = choices.get(id) ?? [];
    if (url.pathname.endsWith('/selections')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        writes.push({ id, revision: body.expectedRevision });
        choices.set(id, [
          ...saved,
          selected(candidate(body.candidateId, body.candidateId === 'system' ? 'rom' : 'metadata')),
        ]);
      }
      return Response.json({
        sourceId: id,
        revision: choices.get(id)?.length ?? 0,
        matches: choices.get(id) ?? [],
      });
    }
    assert.deepEqual(JSON.parse(String(init?.body)), {
      online: true,
      checksum: true,
      providerIds: ['test.provider'],
      managerId: 'test.manager',
    });
    return Response.json({
      sourceId: id,
      requestId: 'request',
      plugins: [],
      problems:
        id === 'partial' ? [{ providerId: 'broken.provider', code: 'provider-failed' }] : [],
      candidates:
        id === 'empty'
          ? []
          : id === 'ambiguous'
            ? [candidate('one'), candidate('two')]
            : id === 'hint'
              ? [candidate('name', 'metadata', 'name')]
              : id === 'exact'
                ? [
                    candidate('metadata'),
                    candidate('system', 'rom'),
                    candidate('cover', 'artwork', 'name'),
                  ]
                : [candidate('new')],
    });
  });
  t.after(f.restore);
  const bulk = createBulkMatching(f.client);
  t.after(() => bulk.dispose());
  await bulk.start(
    { libraryId: 'library' },
    { online: true, providerIds: ['test.provider'], managerId: 'test.manager' },
  );
  assert.deepEqual(writes, [
    { id: 'exact', revision: 0 },
    { id: 'exact', revision: 1 },
  ]);
  assert.deepEqual(
    get(bulk).rows.map((r) => r.status),
    ['review', 'review', 'saved', 'review', 'review', 'unmatched'],
  );
  assert.equal(get(bulk).phase, 'complete');
  assert.equal(choices.get('preserved')?.[0]?.id, 'old');
});

test('containers use filename review, offline and managed uploads are skipped, failures do not stop later games', async (t) => {
  const rows = ['disc', 'archive', 'large', 'offline', 'fail', 'good'].map((id) =>
    entry('source', id),
  );
  const [disc, archive, large, offline] = rows;
  assert.ok(disc?.source && archive?.source && large?.source && offline?.source);
  disc.name = disc.source.name = 'Game.cue';
  disc.source.groupFileCount = 3;
  archive.name = archive.source.name = 'Game.zip';
  large.source.size = 65 * 1024 * 1024;
  offline.source.availability = 'offline';
  rows.push(entry('item', 'managed'));
  const f = transport((url, init) => {
    if (url.pathname === '/api/v1/browse') return Response.json({ items: rows, nextCursor: null });
    const id = url.pathname.split('/')[4] ?? '';
    assert.notEqual(id, 'offline');
    assert.notEqual(id, 'managed');
    if (url.pathname.endsWith('/selections')) {
      assert.notEqual(
        init?.method,
        'PUT',
        'provider confidence alone cannot verify an un-hashed container',
      );
      return Response.json({ sourceId: id, revision: 0, matches: [] });
    }
    if (id === 'fail') return problem(503);
    assert.equal(JSON.parse(String(init?.body)).checksum, id === 'good');
    return Response.json({
      sourceId: id,
      requestId: 'r',
      plugins: [],
      problems: [],
      candidates: id === 'good' ? [] : [candidate('claimed-exact')],
    });
  });
  t.after(f.restore);
  const bulk = createBulkMatching(f.client);
  t.after(() => bulk.dispose());
  await bulk.start({ libraryId: 'library' }, {});
  assert.deepEqual(
    get(bulk).rows.map((r) => r.status),
    ['review', 'review', 'review', 'skipped', 'failed', 'unmatched', 'skipped'],
  );
});

test('pause cancels pending work, late responses cannot save, and resume processes remaining games once', async (t) => {
  const pending = deferred<Response>();
  let delay = true;
  let writes = 0;
  let signal: AbortSignal | null | undefined;
  const f = transport((url, init) => {
    if (url.pathname === '/api/v1/browse')
      return Response.json({ items: [entry('source', 'one')], nextCursor: null });
    if (url.pathname.endsWith('/selections')) {
      if (init?.method === 'PUT') writes++;
      return Response.json({
        sourceId: 'one',
        revision: writes,
        matches: writes ? [selected(candidate('exact'))] : [],
      });
    }
    signal = init?.signal;
    return delay
      ? pending.promise
      : Response.json({
          sourceId: 'one',
          requestId: 'r',
          plugins: [],
          problems: [],
          candidates: [candidate('exact')],
        });
  });
  t.after(f.restore);
  const bulk = createBulkMatching(f.client);
  t.after(() => bulk.dispose());
  const started = bulk.start({ libraryId: 'library' }, {});
  // Wait for the request to reach the transport, without a real timer.
  for (let i = 0; i < 30 && !signal; i++) await Promise.resolve();
  assert.ok(signal);
  bulk.pause();
  assert.equal(signal.aborted, true);
  pending.resolve(
    Response.json({
      sourceId: 'one',
      requestId: 'r',
      plugins: [],
      problems: [],
      candidates: [candidate('exact')],
    }),
  );
  await started;
  assert.equal(writes, 0);
  assert.equal(get(bulk).phase, 'paused');
  delay = false;
  await bulk.resume();
  assert.equal(writes, 1);
  assert.equal(get(bulk).phase, 'complete');
});

test('authorization loss clears the queue and prevents further processing or resuming', async (t) => {
  const f = transport((url) =>
    url.pathname === '/api/v1/browse'
      ? Response.json({ items: [entry('source', 'one'), entry('source', 'two')], nextCursor: null })
      : problem(403),
  );
  t.after(f.restore);
  const bulk = createBulkMatching(f.client);
  t.after(() => bulk.dispose());
  await bulk.start({ libraryId: 'library' }, {});
  assert.deepEqual(get(bulk).rows, []);
  assert.ok(get(bulk).failure);
  const count = f.requests.length;
  await bulk.resume();
  await bulk.start({ libraryId: 'library' }, {});
  assert.equal(f.requests.length, count);
});

test('a concurrent edit is not overwritten and only failed games retry', async (t) => {
  let conflict = true;
  const reads: string[] = [];
  let writes = 0;
  const f = transport((url, init) => {
    if (url.pathname === '/api/v1/browse')
      return Response.json({
        items: [entry('source', 'stale'), entry('source', 'next')],
        nextCursor: null,
      });
    const id = url.pathname.split('/')[4] ?? '';
    if (url.pathname.endsWith('/selections')) {
      if (init?.method === 'PUT') {
        writes++;
        assert.equal(JSON.parse(String(init.body)).expectedRevision, 0);
        return problem(409, 'matching-conflict');
      }
      return Response.json({
        sourceId: id,
        revision: conflict ? 0 : 7,
        matches: conflict ? [] : [selected(candidate('chosen-by-owner'))],
      });
    }
    reads.push(id);
    return Response.json({
      sourceId: id,
      requestId: 'r',
      plugins: [],
      problems: [],
      candidates: id === 'stale' ? [candidate('exact')] : [],
    });
  });
  t.after(f.restore);
  const bulk = createBulkMatching(f.client);
  t.after(() => bulk.dispose());
  await bulk.start({ libraryId: 'library' }, {});
  assert.deepEqual(
    get(bulk).rows.map((r) => r.status),
    ['failed', 'unmatched'],
  );
  assert.equal(writes, 1);
  conflict = false;
  await bulk.retryFailures();
  assert.deepEqual(reads, ['stale', 'next', 'stale']);
  assert.equal(writes, 1, 'retry loads current choices and preserves the concurrent edit');
  assert.equal(get(bulk).rows[0]?.status, 'saved');
});

test('discovery cancellation aborts the browse and a late page cannot repopulate a reset library', async (t) => {
  const pending = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const f = transport((_url, init) => {
    signal = init?.signal;
    return pending.promise;
  });
  t.after(f.restore);
  const bulk = createBulkMatching(f.client);
  t.after(() => bulk.dispose());
  const run = bulk.start({ libraryId: 'old' }, {});
  assert.ok(signal);
  bulk.reset();
  assert.equal(signal.aborted, true);
  pending.resolve(Response.json({ items: [entry('source', 'old')], nextCursor: null }));
  await run;
  assert.deepEqual(get(bulk).rows, []);
  assert.equal(get(bulk).phase, 'idle');
});

test('checksum suggestions conflicting with a saved system require review', async (t) => {
  let writes = 0;
  const existing = selected({
    ...candidate('chosen-system', 'rom'),
    metadata: { systemId: 'com.provenance.jaguar' },
  });
  const f = transport((url, init) => {
    if (url.pathname === '/api/v1/browse')
      return Response.json({ items: [entry('source', 'game')], nextCursor: null });
    if (url.pathname.endsWith('/selections')) {
      if (init?.method === 'PUT') writes++;
      return Response.json({ sourceId: 'game', revision: 1, matches: [existing] });
    }
    return Response.json({
      sourceId: 'game',
      requestId: 'r',
      plugins: [],
      problems: [],
      candidates: [candidate('other-system-metadata')],
    });
  });
  t.after(f.restore);
  const bulk = createBulkMatching(f.client);
  t.after(() => bulk.dispose());
  await bulk.start({ libraryId: 'library' }, {});
  assert.equal(writes, 0);
  assert.equal(get(bulk).rows[0]?.status, 'review');
});
