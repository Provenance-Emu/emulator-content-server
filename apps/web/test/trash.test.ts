import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentError, type TrashEntry } from '@ecs/client';
import { get } from 'svelte/store';
import {
  createTrash,
  createUndoToast,
  daysLeft,
  moveToTrash,
  type TrashClient,
  timeLeft,
} from '../src/lib/trash.js';

const entry = (id: string, kind: 'item' | 'file' = 'item'): TrashEntry => ({
  kind,
  id,
  name: `Name ${id}`,
  libraryId: 'library',
  itemId: kind === 'item' ? id : 'game',
  itemTitle: 'Game',
  systemIdentifier: 'com.provenance.nes',
  size: 10,
  fileCount: 1,
  deletedAt: '2026-11-16T00:00:00.000Z',
  purgeAfter: '2026-12-16T00:00:00.000Z',
  itemDeleted: false,
});

function fixture(pages: TrashEntry[][]) {
  const calls: string[] = [];
  let failing: unknown = null;
  const client: TrashClient = {
    async trash(query = {}) {
      calls.push(`list:${query.cursor ?? ''}`);
      const index = query.cursor ? Number(query.cursor) : 0;
      return {
        entries: structuredClone(pages[index] ?? []),
        nextCursor: index + 1 < pages.length ? String(index + 1) : null,
      };
    },
    async deleteItem(id) {
      calls.push(`delete-item:${id}`);
    },
    async deleteFile(id) {
      calls.push(`delete-file:${id}`);
    },
    async restoreItem(id) {
      calls.push(`restore-item:${id}`);
      if (failing) throw failing;
      return {} as never;
    },
    async restoreFile(id) {
      calls.push(`restore-file:${id}`);
      if (failing) throw failing;
      return {} as never;
    },
  };
  return { client, calls, fail: (error: unknown) => (failing = error) };
}

test('days left never promises more time than the server will keep', () => {
  const now = Date.parse('2026-11-16T00:00:00.000Z');
  assert.equal(daysLeft('2026-12-16T00:00:00.000Z', now), 30);
  assert.equal(daysLeft('2026-11-17T12:00:00.000Z', now), 1);
  assert.equal(daysLeft('2026-11-16T05:00:00.000Z', now), 0);
  assert.equal(daysLeft('2026-11-01T00:00:00.000Z', now), 0);
  assert.equal(timeLeft('2026-12-16T00:00:00.000Z', now), '30 days left');
  assert.equal(timeLeft('2026-11-17T12:00:00.000Z', now), '1 day left');
  assert.equal(timeLeft('2026-11-16T05:00:00.000Z', now), 'Removed within a day');
});

test('the trash loads a page, appends the next, and drops an entry once it is restored', async () => {
  const f = fixture([[entry('a'), entry('b', 'file')], [entry('c')]]);
  let changed = 0;
  const trash = createTrash(f.client, () => changed++);
  await trash.load();
  assert.deepEqual(
    get(trash).entries.map((item) => item.id),
    ['a', 'b'],
  );
  assert.equal(get(trash).more, true);
  await trash.loadMore();
  assert.deepEqual(
    get(trash).entries.map((item) => item.id),
    ['a', 'b', 'c'],
  );
  assert.equal(get(trash).more, false);

  await trash.restore(get(trash).entries[1] as TrashEntry);
  assert.deepEqual(
    get(trash).entries.map((item) => item.id),
    ['a', 'c'],
  );
  assert.equal(get(trash).notice, 'Name b restored.');
  assert.equal(changed, 1);
  assert.ok(f.calls.includes('restore-file:b'));
});

test('a failed restore keeps the entry and says why', async () => {
  const f = fixture([[entry('a')]]);
  const trash = createTrash(f.client);
  await trash.load();
  f.fail(
    new ContentError(409, {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'conflict',
      detail: 'Restore the game first',
    } as never),
  );
  await trash.restore(get(trash).entries[0] as TrashEntry);
  assert.equal(get(trash).entries.length, 1);
  assert.equal(get(trash).failure, 'Restore the game first');
  assert.equal(get(trash).restoring, null);
});

test('moving a game to the trash offers one undo that restores it', async () => {
  const f = fixture([]);
  const toast = createUndoToast(() => () => {});
  let changed = 0;
  assert.equal(
    await moveToTrash(f.client, toast, { kind: 'item', id: 'game', name: 'Example' }, () => {
      changed++;
    }),
    null,
  );
  assert.equal(get(toast)?.message, 'Moved Example to the trash.');
  assert.equal(changed, 1);
  await toast.undo();
  assert.deepEqual(f.calls, ['delete-item:game', 'restore-item:game']);
  assert.equal(changed, 2);
  assert.equal(get(toast)?.message, 'Example restored.');
  assert.equal(get(toast)?.canUndo, false);
  await toast.undo();
  assert.equal(f.calls.length, 2, 'undo runs once');
});

test('an undo that fails says so and can be tried again', async () => {
  const f = fixture([]);
  const toast = createUndoToast(() => () => {});
  await moveToTrash(
    f.client,
    toast,
    { kind: 'file', id: 'save', name: 'save.generated' },
    () => {},
  );
  f.fail(new TypeError('offline'));
  await toast.undo();
  assert.equal(get(toast)?.failure, 'The server is unreachable.');
  assert.equal(get(toast)?.canUndo, true);
  f.fail(null);
  await toast.undo();
  assert.equal(get(toast)?.message, 'save.generated restored.');
});

test('the toast leaves on its own and a newer one replaces it', () => {
  const timers: Array<() => void> = [];
  let cancelled = 0;
  const toast = createUndoToast((expire) => {
    timers.push(expire);
    return () => cancelled++;
  });
  toast.show('First', async () => undefined);
  toast.show('Second', async () => undefined);
  assert.equal(cancelled, 1);
  assert.equal(get(toast)?.message, 'Second');
  timers[0]?.();
  assert.equal(get(toast)?.message, 'Second', 'an old timer cannot close a newer toast');
  timers[1]?.();
  assert.equal(get(toast), null);
});
