import assert from 'node:assert/strict';
import test from 'node:test';
import type { LibraryJob, LibraryJobItem } from '@ecs/client';
import { get } from 'svelte/store';
import { createLibraryJobs } from '../src/lib/library-jobs.js';

test('two views show shared server progress and disposing a view never cancels work', async () => {
  let job: LibraryJob = {
    id: 'shared',
    kind: 'match',
    scope: { libraryId: 'library' },
    options: {},
    state: 'running',
    total: 100000,
    processed: 17,
    saved: 5,
    review: 8,
    unmatched: 4,
    failed: 0,
    skipped: 0,
    currentSourceId: null,
    error: null,
    createdAt: '',
    updatedAt: '',
    interruptedCount: 0,
  };
  let cancelled = 0;
  const client = {
    libraryJobs: async () => ({ jobs: [job], nextCursor: null }),
    libraryJob: async () => ({ job }),
    libraryJobItems: async (_id: string, query: { limit?: number }) => {
      assert.equal(query.limit, 20);
      return { items: [], nextCursor: null };
    },
    createLibraryJob: async () => ({ job, reused: true }),
    cancelLibraryJob: async () => {
      cancelled++;
      job = { ...job, state: 'cancelled' };
      return { job };
    },
    resumeLibraryJob: async () => ({ job }),
    reviewLibraryJobItem: async () => ({ job }),
  };
  const a = createLibraryJobs(client, { libraryId: 'library' }),
    b = createLibraryJobs(client, { libraryId: 'library' });
  await a.refresh();
  await b.refresh();
  assert.equal(get(a).selectedId, get(b).selectedId);
  assert.equal(get(b).jobs[0]?.total, 100000);
  a.dispose();
  assert.equal(cancelled, 0);
  await b.cancel('shared');
  assert.equal(cancelled, 1);
  assert.equal(get(b).jobs[0]?.state, 'cancelled');
  b.dispose();
});

test('job history pages retain a selected older match while newer scans arrive', async () => {
  const make = (id: string): LibraryJob => ({
    id,
    kind: 'match',
    scope: {},
    options: {},
    state: 'completed',
    total: 1,
    processed: 1,
    saved: 0,
    review: 1,
    unmatched: 0,
    failed: 0,
    skipped: 0,
    currentSourceId: null,
    error: null,
    createdAt: '',
    updatedAt: '',
    interruptedCount: 0,
  });
  let newest = make('recent-scan');
  const older = make('old-match');
  let updated = { ...older };
  const client = {
    libraryJobs: async (query: { cursor?: string }) =>
      query.cursor
        ? { jobs: [older], nextCursor: null }
        : { jobs: [newest], nextCursor: 'history-page' },
    libraryJob: async (id: string) => {
      assert.equal(id, older.id);
      return { job: updated };
    },
    libraryJobItems: async () => ({ items: [], nextCursor: null }),
    createLibraryJob: async () => ({ job: older, reused: true }),
    cancelLibraryJob: async () => ({ job: older }),
    resumeLibraryJob: async () => ({ job: older }),
    reviewLibraryJobItem: async () => ({ job: older }),
  };
  const view = createLibraryJobs(client, { libraryId: 'library' });
  try {
    await view.refresh();
    assert.equal(get(view).nextJobsCursor, 'history-page');
    await view.older();
    assert.deepEqual(
      get(view).jobs.map((job) => job.id),
      ['recent-scan', 'old-match'],
    );
    await view.choose(older.id);
    newest = make('newest-scan');
    updated = { ...older, review: 0, updatedAt: 'later' };
    await view.refresh();
    assert.equal(get(view).selectedId, older.id);
    assert.equal(get(view).jobs.find((job) => job.id === older.id)?.review, 0);
    assert.equal(get(view).nextJobsCursor, null);
  } finally {
    view.dispose();
  }
});

test('showing more results adds a batch, and a refresh reads every batch shown again', async () => {
  let job = {
    id: 'match',
    kind: 'match',
    scope: { libraryId: 'library' },
    options: {},
    state: 'running',
    total: 60,
    processed: 60,
    saved: 0,
    review: 60,
    unmatched: 0,
    failed: 0,
    skipped: 0,
    currentSourceId: null,
    error: null,
    createdAt: '',
    updatedAt: 'a',
    interruptedCount: 0,
  } as LibraryJob;
  let rows = Array.from(
    { length: 45 },
    (_, index) =>
      ({ sourceId: `source-${index}`, status: 'review', suggestions: 1 }) as LibraryJobItem,
  );
  const reads: (string | undefined)[] = [];
  const client = {
    libraryJobs: async () => ({ jobs: [job], nextCursor: null }),
    libraryJob: async () => ({ job }),
    libraryJobItems: async (_id: string, query: { limit?: number; cursor?: string }) => {
      reads.push(query.cursor);
      const from = Number(query.cursor ?? 0);
      return {
        items: rows.slice(from, from + 20),
        nextCursor: from + 20 < rows.length ? String(from + 20) : null,
      };
    },
    createLibraryJob: async () => ({ job, reused: true }),
    cancelLibraryJob: async () => ({ job }),
    resumeLibraryJob: async () => ({ job }),
    reviewLibraryJobItem: async () => ({ job }),
  };
  const jobs = createLibraryJobs(client, { libraryId: 'library' });
  await jobs.refresh();
  assert.equal(get(jobs).items.length, 20);
  await jobs.more();
  assert.deepEqual(reads, [undefined, '20']);
  assert.equal(get(jobs).items.length, 40);
  assert.equal(get(jobs).items[0]?.sourceId, 'source-0');
  assert.equal(get(jobs).nextCursor, '40');

  // The first result was saved elsewhere; the job changed, so everything shown is read again.
  rows = rows.slice(1);
  job = { ...job, updatedAt: 'b' };
  reads.length = 0;
  await jobs.refresh();
  assert.deepEqual(reads, [undefined, '20']);
  assert.equal(get(jobs).items.length, 40);
  assert.equal(get(jobs).items[0]?.sourceId, 'source-1');

  // Marking a result reviewed keeps the list at the same depth.
  await jobs.reviewed('source-1');
  assert.equal(get(jobs).items.length, 40);

  await jobs.more();
  assert.equal(get(jobs).items.length, 44);
  assert.equal(get(jobs).nextCursor, null);
  await jobs.more();
  assert.equal(get(jobs).items.length, 44);

  // Another filter starts a new list.
  await jobs.filter('failed');
  assert.equal(get(jobs).items.length, 20);
  jobs.dispose();
});
