import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManifestFile } from '@ecs/client';
import { get } from 'svelte/store';
import { createItemPictures, type ItemPicturesController } from '../src/lib/item-pictures.js';
import { problem, transport } from './library-browser-fixture.js';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const file = (id: string, sha = 'a', size = PNG.length): ManifestFile => ({
  id,
  kind: 'artwork',
  relativePath: `art/${id}.png`,
  sha256: sha.repeat(64),
  md5: null,
  crc: null,
  size,
  required: false,
  contentPath: `/api/v1/files/${id}/content`,
});
async function settled(pictures: ItemPicturesController) {
  for (let turn = 0; turn < 200 && Object.keys(get(pictures).pending).length; turn++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(get(pictures).pending, {});
}

test("an uploaded game's pictures load once, reload when replaced, and are released when gone", async (t) => {
  const f = transport((url) =>
    url.pathname.includes('/not-a-picture/')
      ? new Response(new Uint8Array([1, 2, 3, 4]))
      : new Response(PNG),
  );
  t.after(f.restore);
  const pictures = createItemPictures(f.client);
  t.after(() => pictures.dispose());
  pictures.show([file('cover'), file('not-a-picture')]);
  assert.deepEqual(Object.keys(get(pictures).pending).sort(), ['cover', 'not-a-picture']);
  await settled(pictures);
  const first = get(pictures).urls.cover;
  assert.ok(first);
  // A file that is not really an image keeps its name tile.
  assert.equal(get(pictures).urls['not-a-picture'], undefined);
  assert.equal(f.requests.length, 2);

  pictures.show([file('cover'), file('not-a-picture')]);
  await settled(pictures);
  assert.equal(f.requests.length, 2);
  assert.equal(get(pictures).urls.cover, first);

  // The same file with new contents is read again; the one that was removed is released.
  pictures.show([file('cover', 'b')]);
  await settled(pictures);
  assert.equal(f.requests.length, 3);
  assert.ok(get(pictures).urls.cover);
  assert.notEqual(get(pictures).urls.cover, first);

  // Too large to show: never requested.
  pictures.show([file('cover', 'b'), file('scan', 'a', 9 * 1024 * 1024)]);
  await settled(pictures);
  assert.equal(f.requests.length, 3);

  pictures.show([]);
  assert.deepEqual(get(pictures).urls, {});
});

test('a refused picture clears what was loaded and reports the refusal once', async (t) => {
  const f = transport((url) =>
    url.pathname.includes('/private/') ? problem(403) : new Response(PNG),
  );
  t.after(f.restore);
  const refused: number[] = [];
  const pictures = createItemPictures(f.client, {
    authorizationRejected: (status) => refused.push(status),
  });
  t.after(() => pictures.dispose());
  pictures.show([file('cover')]);
  await settled(pictures);
  assert.ok(get(pictures).urls.cover);
  pictures.show([file('cover'), file('private')]);
  await settled(pictures);
  assert.deepEqual(refused, [403]);
  assert.deepEqual(get(pictures).urls, {});
});
