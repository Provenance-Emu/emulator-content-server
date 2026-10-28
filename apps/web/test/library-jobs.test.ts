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
