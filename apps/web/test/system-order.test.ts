import assert from 'node:assert/strict';
import test from 'node:test';
import {
  orderSystems,
  RECENT_SYSTEMS,
  readRecentSystems,
  withRecentSystem,
} from '../src/lib/system-order.js';

const counts = [
  { systemId: 'gb', count: 40 },
  { systemId: 'nes', count: 900 },
  { systemId: 'snes', count: 900 },
  { systemId: 'psx', count: 12 },
  { systemId: 'n64', count: 300 },
];
const ids = (list: { systemId: string }[]) => list.map((entry) => entry.systemId);

test('the largest systems lead, and equal sizes keep a steady order', () => {
  assert.deepEqual(ids(orderSystems(counts, [])), ['nes', 'snes', 'n64', 'gb', 'psx']);
  assert.deepEqual(ids(orderSystems([...counts].reverse(), [])), [
    'nes',
    'snes',
    'n64',
    'gb',
    'psx',
  ]);
  const names: Record<string, string> = { nes: 'Zeta', snes: 'Alpha' };
  assert.deepEqual(ids(orderSystems(counts, [], (id) => names[id] ?? id)).slice(0, 2), [
    'snes',
    'nes',
  ]);
});

test('systems opened lately come first, newest first, however small', () => {
  assert.deepEqual(ids(orderSystems(counts, ['psx', 'gb'])), ['psx', 'gb', 'nes', 'snes', 'n64']);
  // A recent system with no games here changes nothing.
  assert.deepEqual(ids(orderSystems(counts, ['saturn'])), ['nes', 'snes', 'n64', 'gb', 'psx']);
  assert.equal(counts[0]?.systemId, 'gb', 'the given list is left as it was');
});

test('opening a game moves its system to the front of a short list', () => {
  let recent: string[] = [];
  for (const id of ['a', 'b', 'c', 'd', 'b']) recent = withRecentSystem(recent, id);
  assert.deepEqual(recent, ['b', 'd', 'c']);
  assert.equal(recent.length, RECENT_SYSTEMS);
  assert.deepEqual(withRecentSystem(recent, 'unknown'), recent);
  assert.deepEqual(withRecentSystem(recent, null), recent);
});

test('whatever is stored reads as a short list of names', () => {
  const stored = (value: string) => ({ getItem: () => value, setItem: () => {} });
  assert.deepEqual(readRecentSystems(stored('["a","a",4,"","b","c","d"]')), ['a', 'b', 'c']);
  for (const value of ['', 'nope', '{"a":1}', 'null'])
    assert.deepEqual(readRecentSystems(stored(value)), []);
  assert.deepEqual(
    readRecentSystems({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
    }),
    [],
  );
});
