import assert from 'node:assert/strict';
import test from 'node:test';
import { createChangeWatch } from '../src/lib/change-watch.js';
import { deferred, serverFixture } from './lifecycle-fixture.js';

const change = (cursor: number, entityType = 'source') => ({
  cursor,
  entityType,
  entityId: `generated-${cursor}`,
  op: 'updated',
  libraryId: null,
  itemId: null,
  sensitive: false,
  recordedAt: '2026-10-20T00:00:00Z',
});

test('one watcher pages to an unchanged cursor and coalesces source and root invalidation', async () => {
  const f = serverFixture();
  const cursors: string[] = [];
  f.changes = async (cursor) => {
    cursors.push(cursor);
    if (cursor === '0') return Response.json({ changes: [change(1)], nextCursor: '1' });
    if (cursor === '1')
      return Response.json({ changes: [change(2, 'content-root')], nextCursor: '2' });
    return Response.json({ changes: [], nextCursor: '2' });
  };
  let invalidations = 0;
  const watch = createChangeWatch(f.context.client, {
    scheduler: f.scheduler,
    invalidate() {
      invalidations++;
    },
    unauthorized() {
      assert.fail('unexpected unauthorized callback');
    },
  });
  try {
    await Promise.all([watch.start(), watch.start()]);
    assert.deepEqual(cursors, ['0', '1', '2']);
    assert.equal(invalidations, 1);
    assert.equal(f.scheduler.pending, 1);
    await f.scheduler.tick();
    assert.deepEqual(cursors, ['0', '1', '2', '2']);
    assert.equal(invalidations, 1);
    assert.equal(f.scheduler.pending, 1);
    assert.ok(f.requests.every(({ path }) => path === '/api/v1/changes'));
  } finally {
    watch.dispose();
    f.restore();
  }
});

test('partial feed progress remains retryable after a transient page error', async () => {
  const f = serverFixture();
  let failed = false;
  f.changes = async (cursor) => {
    if (cursor === '0') return Response.json({ changes: [change(1)], nextCursor: '1' });
    if (!failed) {
      failed = true;
      return Response.json({}, { status: 503 });
    }
    return Response.json({ changes: [], nextCursor: '1' });
  };
  let invalidations = 0;
  const watch = createChangeWatch(f.context.client, {
    scheduler: f.scheduler,
    invalidate() {
      invalidations++;
    },
    unauthorized() {},
  });
  try {
    await watch.start();
    assert.equal(
      invalidations,
      1,
      'already received changes must not be lost on a failed later page',
    );
    await f.scheduler.tick();
    assert.equal(invalidations, 1);
    assert.equal(f.scheduler.pending, 1);
  } finally {
    watch.dispose();
    f.restore();
  }
});

test('disposal prevents callbacks from an outstanding change response and removes scheduled work', async () => {
  const f = serverFixture();
  const pending = deferred<Response>();
  const requested = deferred<void>();
  f.changes = () => {
    requested.resolve();
    return pending.promise;
  };
  let invalidations = 0;
  let unauthorized = 0;
  const watch = createChangeWatch(f.context.client, {
    scheduler: f.scheduler,
    invalidate() {
      invalidations++;
    },
    unauthorized() {
      unauthorized++;
    },
  });
  try {
    const start = watch.start();
    await requested.promise;
    watch.dispose();
    pending.resolve(Response.json({ changes: [change(1)], nextCursor: '1' }));
    await start;
    await watch.start();
    assert.equal(invalidations, 0);
    assert.equal(unauthorized, 0);
    assert.equal(f.scheduler.pending, 0);
  } finally {
    watch.dispose();
    f.restore();
  }
});

test('a 401 invokes unauthorized once, stops polling and does not invalidate private views', async () => {
  const f = serverFixture();
  f.changes = async () => Response.json({}, { status: 401 });
  let invalidations = 0;
  let unauthorized = 0;
  const watch = createChangeWatch(f.context.client, {
    scheduler: f.scheduler,
    invalidate() {
      invalidations++;
    },
    unauthorized() {
      unauthorized++;
    },
  });
  try {
    await watch.start();
    await watch.start();
    assert.equal(unauthorized, 1);
    assert.equal(invalidations, 0);
    assert.equal(f.scheduler.pending, 0);
  } finally {
    watch.dispose();
    f.restore();
  }
});

test('externally driven watcher owns no timer and ignores overlapping polls', async () => {
  const f = serverFixture();
  const watch = createChangeWatch(f.context.client, {
    scheduler: null,
    invalidate() {},
    unauthorized() {},
  });
  try {
    await watch.start();
    const pending = deferred<Response>();
    f.changes = () => pending.promise;
    const poll = watch.poll();
    const overlap = watch.poll();
    pending.resolve(Response.json({ changes: [], nextCursor: '0' }));
    await Promise.all([poll, overlap]);
    assert.equal(f.requests.length, 2);
    assert.equal(f.scheduler.pending, 0);
  } finally {
    watch.dispose();
    f.restore();
  }
});
