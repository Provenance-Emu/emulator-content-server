import assert from 'node:assert/strict';
import test from 'node:test';
import type { LibraryBrowseEntry } from '@ecs/client';
import { get } from 'svelte/store';
import { createPreviews } from '../src/lib/previews.js';
import { entry, transport } from './library-browser-fixture.js';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function cover(id: string): LibraryBrowseEntry {
  const row = entry('source', id);
  assert.ok(row.source);
  return { ...row, source: { ...row.source, artworkAvailable: true } };
}

test('covers are added as cards come on screen, kept while they stay, and read again only for a re-read entry', async (t) => {
  const f = transport(() => new Response(PNG));
  t.after(f.restore);
  const previews = createPreviews(f.client);
  t.after(() => previews.dispose());
  const a = cover('a');
  const b = cover('b');
  await previews.request([a]);
  const first = get(previews).urls['source:a'];
  assert.ok(first);
  await previews.request([a, b]);
  assert.equal(f.requests.length, 2);
  assert.equal(get(previews).urls['source:a'], first);
  assert.ok(get(previews).urls['source:b']);
  // The same game read again by a refresh: its cover may have changed.
  await previews.request([cover('a')]);
  assert.equal(f.requests.length, 3);
  assert.ok(get(previews).urls['source:a']);
  assert.notEqual(get(previews).urls['source:a'], first);
  // Its artwork was removed: the cover goes without another request.
  await previews.request([entry('source', 'a')]);
  assert.equal(get(previews).urls['source:a'], undefined);
  assert.ok(get(previews).urls['source:b']);
  assert.equal(f.requests.length, 3);
});

test('a long scroll releases the covers that were requested longest ago', async (t) => {
  const f = transport(() => new Response(PNG));
  t.after(f.restore);
  const previews = createPreviews(f.client);
  t.after(() => previews.dispose());
  for (let batch = 0; batch < 5; batch++)
    await previews.request(Array.from({ length: 60 }, (_, i) => cover(`${batch}-${i}`)));
  const kept = Object.keys(get(previews).urls);
  assert.equal(kept.length, 240);
  assert.equal(kept.includes('source:0-0'), false);
  assert.equal(kept.includes('source:4-59'), true);
});
