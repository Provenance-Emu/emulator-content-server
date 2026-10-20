import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import { createLibraryEditor } from '../src/lib/library-editor.js';
import { folderFixture, selection } from './folder-fixture.js';

test('staging and cancellation make no writes; first folder suggests a name until edited', async (t) => {
  const f = folderFixture(t);
  const editor = createLibraryEditor(f.client, f.context);
  await editor.stageFolder(selection('C:\\Games\\Arcade\\'));
  assert.equal(get(editor).name, 'Arcade');
  editor.setName('Personal');
  await editor.stageFolder(selection('/other'));
  assert.equal(get(editor).name, 'Personal');
  editor.dispose();
  assert.equal(f.calls.length, 0);
});
test('an empty named library creates once and ignores a pending duplicate submit', async (t) => {
  const f = folderFixture(t);
  const editor = createLibraryEditor(f.client, f.context);
  editor.setName('Empty');
  const first = editor.submit();
  const second = editor.submit();
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(get(editor).libraryId, 'created-1');
  assert.equal(f.libraries.length, 2);
});
test('second-folder registration failure retries only unfinished work with the preserved name', async (t) => {
  const f = folderFixture(t);
  const editor = createLibraryEditor(f.client, f.context);
  await editor.stageFolder(selection('/first'));
  await editor.stageFolder(selection('/second'));
  editor.setName('Chosen');
  f.override(async (path, body) =>
    path.endsWith('/roots') && body.path === '/second'
      ? Response.json({ title: 'No folder' }, { status: 400 })
      : null,
  );
  assert.equal(await editor.submit(), false);
  assert.equal(get(editor).libraryId, 'created-1');
  assert.equal(get(editor).folders[0]?.rootId, 'root-0');
  assert.match(get(editor).folders[1]?.failure ?? '', /No folder/);
  f.override(null);
  assert.equal(await editor.retryRemaining(), true);
  assert.equal(f.libraries.length, 2);
  assert.equal(f.roots.length, 2);
  assert.equal(get(editor).name, 'Chosen');
  assert.deepEqual(
    f.calls.filter((c) => c.path.endsWith('/scan')).map((c) => c.path),
    ['/api/v1/roots/root-0/scan', '/api/v1/roots/root-1/scan'],
  );
});
test('scan failure preserves root identity before retry', async (t) => {
  const f = folderFixture(t);
  const editor = createLibraryEditor(f.client, f.context);
  await editor.stageFolder(selection());
  f.override(async (path) =>
    path.endsWith('/scan') ? Response.json({ title: 'Scan unavailable' }, { status: 503 }) : null,
  );
  assert.equal(await editor.submit(), false);
  assert.equal(get(editor).folders[0]?.rootId, 'root-0');
  f.override(null);
  assert.equal(await editor.retryRemaining(), true);
  assert.equal(f.roots.length, 1);
});
test('lost create response requires explicit existing-library reconciliation, never matching a title', async (t) => {
  const f = folderFixture(t);
  const editor = createLibraryEditor(f.client, f.context);
  editor.setName('Arcade');
  f.override(async (path) => {
    if (path.endsWith('/libraries')) throw new TypeError('response lost');
    return null;
  });
  assert.equal(await editor.submit(), false);
  assert.equal(get(editor).reconciliationRequired, true);
  assert.equal(await editor.retryRemaining(), false);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/libraries')).length, 1);
  f.override(null);
  assert.equal(await editor.reconcileCreatedLibrary('library'), true);
  assert.equal(await editor.retryRemaining(), true);
  assert.equal(get(editor).libraryId, 'library');
});

test('a context revoked during validation cannot create a library', async (t) => {
  const f = folderFixture(t);
  let valid = true;
  const context = {
    ...f.context,
    isCurrent: () => valid,
    folderSelection: {
      async choose() {
        return selection();
      },
      async validate() {
        return true;
      },
    },
  };
  const editor = createLibraryEditor(f.client, context);
  await editor.stageFolder(selection());
  context.folderSelection.validate = async () => {
    valid = false;
    return true;
  };
  assert.equal(await editor.submit(), false);
  assert.equal(f.calls.length, 0);
});

test('a committed library and scanned folder survive a failed discovery followup without repeating writes', async (t) => {
  const f = folderFixture(t);
  let refreshes = 0;
  const editor = createLibraryEditor(f.client, {
    ...f.context,
    onchanged: () => {
      if (++refreshes === 1) throw new Error('Discovery unavailable');
    },
  });
  await editor.stageFolder(selection());
  assert.equal(await editor.submit(), false);
  assert.equal(get(editor).libraryId, 'created-1');
  assert.equal(get(editor).folders[0]?.scanned, true);
  assert.equal(await editor.retryRemaining(), true);
  assert.equal(f.libraries.length, 2);
  assert.equal(f.roots.length, 1);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/scan')).length, 1);
});

test('retrying a committed root scan does not require an expired native path capability', async (t) => {
  const f = folderFixture(t);
  let valid = true;
  const editor = createLibraryEditor(f.client, {
    ...f.context,
    folderSelection: {
      async choose() {
        return selection();
      },
      async validate() {
        return valid;
      },
    },
  });
  await editor.stageFolder(selection());
  f.override(async (path) =>
    path.endsWith('/scan') ? Response.json({ title: 'Offline' }, { status: 503 }) : null,
  );
  assert.equal(await editor.submit(), false);
  assert.equal(get(editor).folders[0]?.rootId, 'root-0');
  valid = false;
  f.override(null);
  assert.equal(await editor.retryRemaining(), true);
  assert.equal(f.roots.length, 1);
});
