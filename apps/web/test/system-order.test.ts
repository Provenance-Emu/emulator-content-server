import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findSystems,
  GROUP_SYSTEMS_FROM,
  groupSystems,
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

test('typing part of a name or the short identifier finds a system', () => {
  const names: Record<string, string> = {
    'com.provenance.snes': 'Super Nintendo',
    'com.provenance.nes': 'Nintendo',
    'com.provenance.psx': 'PlayStation',
  };
  const list = Object.keys(names).map((systemId) => ({ systemId }));
  const find = (query: string) => ids(findSystems(list, query, (id) => names[id] ?? id));
  assert.deepEqual(find(''), Object.keys(names));
  assert.deepEqual(find('  '), Object.keys(names));
  assert.deepEqual(find('NINT'), ['com.provenance.snes', 'com.provenance.nes']);
  assert.deepEqual(find('nintendo super'), ['com.provenance.snes']);
  assert.deepEqual(find('psx'), ['com.provenance.psx']);
  // The shared prefix of every identifier is not something anyone types to find a system.
  assert.deepEqual(find('provenance'), []);
  assert.deepEqual(find('zzz'), []);
});

test('a long row is grouped by maker, recent systems first and the unplaced last', () => {
  const makers: Record<string, string> = {
    nes: 'Nintendo',
    snes: 'Nintendo',
    gb: 'Nintendo',
    genesis: 'Sega',
    saturn: 'Sega',
    psx: 'Sony',
    mame: 'Arcade',
  };
  const list = [
    ...Object.keys(makers),
    ...Array.from({ length: GROUP_SYSTEMS_FROM }, (_, index) => `odd${index}`),
  ].map((systemId) => ({ systemId, count: systemId === 'psx' ? 500 : 10 }));
  const groups = groupSystems(orderSystems(list, ['saturn']), ['saturn'], (id) => makers[id]);
  assert.deepEqual(
    groups.map((group) => group.name),
    ['Recent', 'Sony', 'Nintendo', 'Arcade', 'Sega', 'Other'],
  );
  assert.deepEqual(ids(groups[0]?.systems ?? []), ['saturn']);
  assert.deepEqual(ids(groups[4]?.systems ?? []), ['genesis']);
  assert.equal(groups.at(-1)?.systems.length, GROUP_SYSTEMS_FROM);
  // Nothing is shown twice or dropped.
  assert.equal(groups.flatMap((group) => group.systems).length, list.length);
});

test('a short row, or one maker alone, is not grouped', () => {
  const few = [
    { systemId: 'nes', count: 1 },
    { systemId: 'psx', count: 1 },
  ];
  assert.deepEqual(
    groupSystems(few, [], (id) => (id === 'nes' ? 'Nintendo' : 'Sony')),
    [{ name: '', systems: few }],
  );
  const many = Array.from({ length: GROUP_SYSTEMS_FROM + 2 }, (_, index) => ({
    systemId: `n${index}`,
    count: 1,
  }));
  assert.deepEqual(
    groupSystems(many, ['n3'], () => 'Nintendo'),
    [{ name: '', systems: many }],
  );
});
