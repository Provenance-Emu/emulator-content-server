import assert from 'node:assert/strict';
import test from 'node:test';
import { readBatches, shownLabel } from '../src/lib/batches.js';

test('batches are read from the start, one cursor after another, and stop at the end', async () => {
  const rows = Array.from({ length: 5 }, (_, index) => index);
  const asked: (string | undefined)[] = [];
  const read = async (cursor?: string) => {
    asked.push(cursor);
    const from = Number(cursor ?? 0);
    return {
      items: rows.slice(from, from + 2),
      nextCursor: from + 2 < rows.length ? String(from + 2) : null,
    };
  };
  assert.deepEqual(await readBatches(2, read), { items: [0, 1, 2, 3], nextCursor: '4' });
  assert.deepEqual(asked, [undefined, '2']);
  asked.length = 0;
  assert.deepEqual(await readBatches(9, read), { items: rows, nextCursor: null });
  assert.deepEqual(asked, [undefined, '2', '4']);
  assert.equal((await readBatches(0, read)).items.length, 2);
});

test('the foot of a list says how much is shown in plain words', () => {
  assert.equal(shownLabel(50, true, ['game', 'games'], 1240), 'Showing 50 of 1,240');
  assert.equal(shownLabel(50, true, ['game', 'games']), 'Showing the first 50');
  assert.equal(shownLabel(50, true, ['game', 'games'], 50), 'Showing the first 50');
  assert.equal(shownLabel(1240, false, ['game', 'games'], 1240), '1,240 games');
  assert.equal(shownLabel(1, false, ['game', 'games']), '1 game');
});
