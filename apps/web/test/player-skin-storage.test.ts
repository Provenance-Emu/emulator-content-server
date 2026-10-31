import assert from 'node:assert/strict';
import test from 'node:test';
import { indexedDB } from 'fake-indexeddb';
import { readSkinArchive } from '../src/player/skins/archive.js';
import { SkinLibrary } from '../src/player/skins/library.js';
import { skinZip } from './skin-fixture.js';

test('library persists originals, checks basis before selection, and refuses silent eviction', async () => {
  const lib = new SkinLibrary('test-skins-' + Math.random(), indexedDB);
  const pkg = await readSkinArchive(await skinZip());
  await lib.put(pkg);
  assert.equal((await lib.get(pkg.id))?.original.size, pkg.original.size);
  await lib.putPreference('scope', { basis: pkg.id, choices: {}, overrides: {} });
  await assert.rejects(
    lib.putPreference('scope', { basis: 'a'.repeat(64), choices: {}, overrides: {} }),
    /missing/i,
  );
  await lib.remove(pkg.id);
  assert.equal(await lib.get(pkg.id), undefined);
  assert.equal((await lib.getPreference('scope'))?.basis, pkg.id);
  assert.equal((await lib.list()).length, 0);
  lib.close();
});
test('denied IndexedDB access does not prevent creating a session-only library', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    get() {
      throw Error('Private storage denied');
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else delete (globalThis as unknown as Record<string, unknown>).indexedDB;
  });
  const lib = new SkinLibrary('denied');
  await assert.rejects(lib.list(), /denied/i);
  lib.close();
});
test('a full library rejects new packages and preserves existing originals', async (t) => {
  const lib = new SkinLibrary('limit-' + Math.random(), indexedDB);
  t.after(() => lib.close());
  const pkg = await readSkinArchive(await skinZip());
  for (let i = 0; i < 20; i++) await lib.put({ ...pkg, id: i.toString(16).padStart(64, '0') });
  await assert.rejects(lib.put({ ...pkg, id: 'f'.repeat(64) }));
  assert.equal((await lib.list()).length, 20);
  assert.equal((await lib.get('0'.repeat(64)))?.original.size, pkg.original.size);
});

test('a malformed byte-buffer record does not hide other installed skins', async (t) => {
  const name = 'corrupt-skins-' + Math.random(),
    lib = new SkinLibrary(name, indexedDB);
  t.after(() => lib.close());
  const pkg = await readSkinArchive(await skinZip());
  await lib.put(pkg);
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result,
        tx = db.transaction('skins', 'readwrite');
      tx.objectStore('skins').put({ encoding: 'bytes-v1', assets: null }, 'malformed');
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
  assert.equal((await lib.list()).length, 1);
  assert.equal((await lib.get(pkg.id))?.id, pkg.id);
});
