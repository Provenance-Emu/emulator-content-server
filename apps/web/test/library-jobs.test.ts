import assert from 'node:assert/strict';
import test from 'node:test';
import type { LibraryJob } from '@ecs/client';
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
