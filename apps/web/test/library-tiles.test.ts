import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContentClient, LibraryBrowsePage } from '@ecs/client';
import { get } from 'svelte/store';
import { createLibraryTiles, gameCountLabel, tileFromPage } from '../src/lib/library-tiles.js';
import { asset, entry } from './library-browser-fixture.js';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
function covered(id: string) {
  return {
    ...entry('item', id),
    previewAsset: { ...asset(`art-${id}`, 'artwork'), itemId: id, size: 12, conflictOf: null },
  };
}
function page(items: LibraryBrowsePage['items'], counts?: number[]): LibraryBrowsePage {
  return {
    items,
    nextCursor: null,
    ...(counts ? { systemCounts: counts.map((count, i) => ({ systemId: `s${i}`, count })) } : {}),
  };
}

test('a tile totals readable games across systems and keeps at most four games that have artwork', () => {
  const tile = tileFromPage(
    page([entry('item', 'plain'), ...['a', 'b', 'c', 'd', 'e'].map(covered)], [100, 20]),
  );
  assert.equal(tile.count, 120);
  assert.deepEqual(
    tile.covers.map((cover) => cover.id),
    ['a', 'b', 'c', 'd'],
  );
});

test('a tile reports an unknown count when the server sends none, and zero for an empty library', () => {
  assert.equal(tileFromPage(page([covered('a')])).count, null);
  assert.equal(tileFromPage(page([], [])).count, 0);
  assert.equal(gameCountLabel(null), '');
  assert.equal(gameCountLabel(0), 'No games yet');
  assert.equal(gameCountLabel(1), '1 game');
  assert.equal(gameCountLabel(1200), '1,200 games');
});

test('tiles load one bounded page per library, survive one failing library, and report a rejected session', async (t) => {
  t.mock.method(URL, 'createObjectURL', () => 'blob:generated');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const queries: unknown[] = [];
  const rejected: number[] = [];
  const client = {
    async browse(query: { libraryId: string }) {
      queries.push(query);
      if (query.libraryId === 'broken') throw new Error('offline');
      return page([covered(`${query.libraryId}-game`)], [3]);
    },
    async collect() {
      return { bytes: png };
    },
  } as unknown as ContentClient;
  const tiles = createLibraryTiles(client, { authorizationRejected: (s) => rejected.push(s) });
  await tiles.load(['one', 'broken']);
  const state = get(tiles);
  assert.deepEqual(queries, [
    { libraryId: 'one', category: 'games', limit: 24 },
    { libraryId: 'broken', category: 'games', limit: 24 },
  ]);
  assert.equal(state.tiles.one?.count, 3);
  assert.equal(state.tiles.broken, undefined);
  assert.equal(state.urls['item:one-game'], 'blob:generated');
  assert.deepEqual(rejected, []);
  tiles.dispose();
});
