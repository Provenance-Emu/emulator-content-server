import assert from 'node:assert/strict';
import test from 'node:test';
import { COVER_SIZE, coverSizeFrom, readCoverSize, saveCoverSize } from '../src/lib/cover-size.js';

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

test('a chosen cover size is kept for the next visit', () => {
  const store = storage();
  assert.equal(readCoverSize(store), COVER_SIZE.initial);
  assert.equal(saveCoverSize(6, store), 6);
  assert.equal(readCoverSize(store), 6);
  saveCoverSize(COVER_SIZE.initial, store);
  assert.equal(store.values.size, 0, 'the usual size leaves nothing behind');
});

test('a stored value the slider cannot show reads as a size it can', () => {
  assert.equal(coverSizeFrom('2'), COVER_SIZE.min);
  assert.equal(coverSizeFrom('400'), COVER_SIZE.max);
  assert.equal(coverSizeFrom('7.3'), 7.5);
  for (const value of ['', ' ', 'large', 'NaN', 'Infinity', null, undefined, 6])
    assert.equal(coverSizeFrom(value), COVER_SIZE.initial);
});

test('blocked storage leaves the usual size and still applies a choice', () => {
  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(readCoverSize(blocked), COVER_SIZE.initial);
  assert.equal(saveCoverSize(10, blocked), 10);
});
