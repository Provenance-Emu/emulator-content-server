import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import { createUploadReview } from '../src/lib/upload-review.js';
import { item } from './library-browser-fixture.js';

const systems = [{ identifier: 'com.provenance.nes', name: 'NES' }];
function file(name: string, path?: string) {
  const f = new File([new Uint8Array([1, 2])], name);
  if (path !== undefined) Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}
test('unknown and binary files never silently choose a kind or the first system', () => {
  const review = createUploadReview({ libraryId: 'library', item: null, systems });
  review.selectFiles([file('game.bin'), file('unknown.xyz'), file('game.nes')]);
  assert.deepEqual(
    get(review).entries.map((e) => [e.kind, e.system]),
    [
      ['', ''],
      ['', ''],
      ['rom', 'com.provenance.nes'],
    ],
  );
  assert.equal(review.validate(), null);
});
test('unsafe client paths cannot reach the queue and safe folder paths survive unchanged', () => {
  for (const path of [
    '../bad.nes',
    '/bad.nes',
    'C:/bad.nes',
    '\\bad.nes',
    'dir\\bad.nes',
    'a//b.nes',
    'a/./b.nes',
    'a/../b.nes',
    'dir/CON.nes',
    'a:b.nes',
    'a /b.nes',
    '',
  ]) {
    const review = createUploadReview({ libraryId: 'library', item: null, systems });
    review.selectFiles([path === '' ? file('') : file('bad.nes', path)]);
    review.setCommonMetadata({ kind: 'rom', system: 'com.provenance.nes', title: 'Game' });
    assert.equal(review.validate(), null, path);
  }
  const review = createUploadReview({ libraryId: 'library', item: null, systems });
  review.selectFiles([file('game.nes', 'Collection/Arcade/game.nes')]);
  assert.equal(review.validate()?.[0]?.relativePath, 'Collection/Arcade/game.nes');
});
test('non-ROM association is explicit, library-scoped, and common metadata never guesses by title', () => {
  const review = createUploadReview({
    libraryId: 'library',
    item: null,
    systems,
    category: 'saves',
  });
  review.selectFiles([file('game.sav'), file('other.sav')]);
  assert.equal(review.validate(), null);
  review.setCommonMetadata({ kind: 'battery_save', target: item() });
  assert.equal(review.validate()?.length, 2);
  review.setCommonMetadata({ target: { ...item(), libraryId: 'other' } });
  assert.equal(review.validate(), null);
});
test('item context supplies an explicit upload target and 10,000 files expose only fifty visible rows', () => {
  const review = createUploadReview({ libraryId: 'library', item: item(), systems });
  review.selectFiles(Array.from({ length: 10_000 }, (_, i) => file(`save-${i}.sav`)));
  assert.equal(get(review).visible.length, 50);
  assert.equal(get(review).entries.length, 10_000);
  const id = get(review).entries[51]?.id ?? '';
  review.setEntryMetadata(id, { kind: 'save_state' });
  review.page(1);
  assert.equal(get(review).visible[1]?.id, id);
  assert.equal(get(review).visible[1]?.kind, 'save_state');
  assert.equal(get(review).visible[1]?.target?.id, 'item');
});

test('common metadata chosen before file selection remains applied when files are replaced', () => {
  const review = createUploadReview({ libraryId: 'library', item: null, systems });
  review.setCommonMetadata({ kind: 'rom', system: 'com.provenance.nes' });
  review.selectFiles([file('first.bin')]);
  assert.equal(review.validate()?.length, 1);
  review.selectFiles([file('second.bin')]);
  assert.equal(review.validate()?.[0]?.system, 'com.provenance.nes');
});
