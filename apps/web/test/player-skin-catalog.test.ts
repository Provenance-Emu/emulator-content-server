import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogPage,
  loadCatalog,
  parseCatalog,
  thumbnailUrl,
} from '../src/player/skins/catalog.js';
import { boundedFetch } from '../src/player/skins/network.js';

const entry = (i: number) => ({
  id: 'id' + i,
  name: 'Pebble ' + i,
  systems: ['NES'],
  downloadURL: 'https://deltastyles.com/files/' + i + '.deltaskin',
  thumbnailURL:
    'https://github.com/Provenance-Emu/skins/releases/download/thumbnails/7335d72cce544432.png',
});
test('catalog skips malformed records, normalizes systems and pages before loading thumbnails', () => {
  const c = parseCatalog(
    JSON.stringify({
      version: 2,
      skins: [...Array.from({ length: 53 }, (_, i) => entry(i)), { name: 'bad' }, null],
    }),
  );
  assert.equal(c.entries.length, 53);
  assert.equal(c.dropped, 2);
  assert.equal(c.entries[0]?.systems[0], 'nes');
  assert.equal(catalogPage(c, '', 'nes', 'delta', 1).items.length, 3);
  assert.equal(catalogPage(c, 'Pebble 12', 'nes', 'delta', 0).total, 1);
  assert.equal(
    thumbnailUrl(c.entries[0]!),
    'https://raw.githubusercontent.com/Provenance-Emu/skins/main/thumbnails/7335d72cce544432.png',
  );
  assert.throws(() => parseCatalog('{}'));
  assert.equal(parseCatalog('{"skins":[]}').entries.length, 0);
});
test('network omits credentials/referrer, rejects destinations, redirects and oversized streams', async () => {
  let init: RequestInit | undefined;
  const fetcher: typeof fetch = async (_u, i) => {
    init = i;
    return new Response('abc');
  };
  assert.equal(
    new TextDecoder().decode(
      await boundedFetch('https://emuskins.com/catalog.json', 10, undefined, fetcher),
    ),
    'abc',
  );
  assert.equal(init?.credentials, 'omit');
  assert.equal(init?.referrerPolicy, 'no-referrer');
  assert.equal(init?.redirect, 'error');
  for (const u of [
    'http://emuskins.com/catalog.json',
    'https://emuskins.com.evil.test/catalog.json',
    'https://user@emuskins.com/catalog.json',
    'https://localhost/a',
  ])
    await assert.rejects(boundedFetch(u, 10, undefined, fetcher));
  await assert.rejects(
    boundedFetch('https://emuskins.com/catalog.json', 2, undefined, fetcher),
    /limit/,
  );
});
test('offline catalog returns stale cache and fresh cache avoids networking', async () => {
  let cache = { text: JSON.stringify({ skins: [entry(1)] }), time: 0 };
  const storage = {
    getCatalog: async () => cache,
    putCatalog: async (v: typeof cache) => {
      cache = v;
    },
  };
  let calls = 0;
  const offline: typeof fetch = async () => {
    calls++;
    throw Error('Offline');
  };
  const c = await loadCatalog(storage, false, undefined, offline, 100_000_000);
  assert.equal(c.stale, true);
  assert.equal(c.catalog.entries.length, 1);
  cache.time = 100_000_000;
  await loadCatalog(storage, false, undefined, offline, 100_000_001);
  assert.equal(calls, 2);
});
