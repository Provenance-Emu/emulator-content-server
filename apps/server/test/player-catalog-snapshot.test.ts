import assert from 'node:assert/strict';
import test from 'node:test';
import { playerCatalog } from '../src/player-catalog.js';
import {
  createPlayerCatalogSnapshot,
  playerCatalogEntryId,
} from '../src/player-catalog-snapshot.js';
import { upstreamFixture } from './player-cache-fixture.js';

test('snapshot identity is stable across object key order and detached from mutable inputs', () => {
  const { entry } = upstreamFixture();
  const snapshot = createPlayerCatalogSnapshot([entry]);
  const reordered = Object.fromEntries(Object.entries(entry).reverse()) as typeof entry;
  assert.equal(snapshot.id, createPlayerCatalogSnapshot([reordered]).id);
  assert.equal(snapshot.schemaVersion, 1);
  assert.match(snapshot.id, /^[a-f0-9]{64}$/);
  entry.systems.push('com.provenance.nes');
  assert.deepEqual(snapshot.entries[0]?.systems, ['com.provenance.gb']);
  assert.throws(() => snapshot.entries[0]?.systems.push('com.provenance.nes'), TypeError);
});

test('snapshot and entry identity cover pair bytes, runtime and provenance metadata', () => {
  const { entry } = upstreamFixture();
  const initial = createPlayerCatalogSnapshot([entry]);
  const pair = createPlayerCatalogSnapshot([upstreamFixture(2).entry]);
  assert.notEqual(initial.id, pair.id);
  const pairEntry = pair.entries[0];
  assert.ok(pairEntry);
  assert.notEqual(playerCatalogEntryId(entry), playerCatalogEntryId(pairEntry));
  const next = structuredClone(entry);
  const web = next.upstream?.manifest.player?.web;
  assert.ok(web);
  web.maxContentBytes++;
  assert.notEqual(initial.id, createPlayerCatalogSnapshot([next]).id);
  next.provenance = { license: 'Generated', sourceInfo: 'https://example.com/source' };
  assert.notEqual(playerCatalogEntryId(entry), playerCatalogEntryId(next));
});

test('snapshots reject duplicate IDs and retain upstream license and immutable info pins', () => {
  const { entry } = upstreamFixture();
  assert.throws(() => createPlayerCatalogSnapshot([entry, entry]), /Duplicate/);
  const snapshot = createPlayerCatalogSnapshot(playerCatalog);
  for (const entry of snapshot.entries.filter((entry) => entry.upstream)) {
    assert.ok(entry.provenance?.license);
    assert.match(entry.provenance?.sourceInfo ?? '', /\/[a-f0-9]{40}\//);
    assert.match(entry.provenance?.infoSha256 ?? '', /^[a-f0-9]{64}$/);
  }
});
