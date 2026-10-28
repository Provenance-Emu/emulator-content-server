import { resolve } from 'node:path';
import { build } from 'vite';
import type { UploadCheckpoint } from '../../src/lib/upload-checkpoint';
import { expect, test } from './fixture';

type JournalModule = typeof import('../../src/lib/upload-journal');
let harness = '';
test.beforeAll(async () => {
  // Bundle the actual journal/parser for a same-origin browser module; no dev service or app build.
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: { entry: resolve('src/lib/upload-journal.ts'), formats: ['es'] },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Unexpected harness build');
  const entry = output.output.find((output) => output.type === 'chunk' && output.isEntry);
  if (entry?.type !== 'chunk') throw new Error('Journal harness was not built');
  harness = entry.code;
});
test.beforeEach(async ({ page, fixture }) => {
  await page.route('**/ui/upload-journal-test.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: harness,
    }),
  );
  await page.goto(`${fixture.origin}/ui/`);
  await page.evaluate(async () => {
    Object.assign(window, { __uploadJournal: await import('/ui/upload-journal-test.js') });
  });
});
function snapshot(libraryId = 'library-a'): UploadCheckpoint {
  return {
    version: 1,
    libraryId,
    itemId: null,
    touched: [],
    entries: [
      {
        id: 'entry-a',
        name: 'generated.nes',
        size: 3,
        sha256: 'a'.repeat(64),
        relativePath: 'generated.nes',
        title: 'Generated game',
        kind: 'rom',
        system: 'com.provenance.nes',
        target: null,
        phase: 'waiting',
        sent: 0,
        idempotencyKey: 'generated-operation',
        baseRevision: null,
      },
    ],
  };
}

test('IndexedDB transactions reject competing journals and stale revisions after remove/discard and recreation', async ({
  page,
}) => {
  const result = await page.evaluate(async (saved) => {
    const api = (window as unknown as { __uploadJournal: JournalModule }).__uploadJournal;
    const make = () => {
      const journal = api.createUploadJournal(
        location.origin,
        'generated-scope',
        saved.libraryId,
        null,
        () => true,
      );
      if (!journal) throw new Error('IndexedDB was unavailable');
      return journal;
    };
    const left = make();
    const right = make();
    const race = await Promise.allSettled([left.save(saved, null), right.save(saved, null)]);
    const first = await left.read();
    if (!first) throw new Error('Missing checkpoint');
    const updated = await left.save(saved, first.revision);
    const staleRemove = await right.remove(first.revision).then(
      () => false,
      () => true,
    );
    await left.remove(updated);
    const next = make();
    const recreated = await next.save(saved, null);
    const staleSave = await right.save(saved, first.revision).then(
      () => false,
      () => true,
    );
    const staleDelete = await right.remove(first.revision).then(
      () => false,
      () => true,
    );
    if (!next.discard) throw new Error('Explicit discard unavailable');
    await next.discard();
    const afterDiscard = await make().save(saved, null);
    return {
      winners: race.filter((value) => value.status === 'fulfilled').length,
      losers: race.filter((value) => value.status === 'rejected').length,
      staleRemove,
      staleSave,
      staleDelete,
      increasing: first.revision < updated && updated < recreated && recreated < afterDiscard,
    };
  }, snapshot());
  expect(result).toEqual({
    winners: 1,
    losers: 1,
    staleRemove: true,
    staleSave: true,
    staleDelete: true,
    increasing: true,
  });
  await page.reload();
  const restored = await page.evaluate(async (saved) => {
    const api: JournalModule = await import('/ui/upload-journal-test.js');
    return api
      .createUploadJournal(location.origin, 'generated-scope', saved.libraryId, null, () => true)
      ?.read();
  }, snapshot());
  expect(restored?.snapshot.entries[0]?.title).toBe('Generated game');
});

test('credential purge removes both scoped stores and whitelisted metadata never stores credentials', async ({
  page,
}) => {
  const result = await page.evaluate(async (saved) => {
    const api = (window as unknown as { __uploadJournal: JournalModule }).__uploadJournal;
    const credential = 'generated-private-scope';
    const origin = 'https://example.invalid';
    const first = api.createUploadJournal(
      `${origin}:443/path`,
      credential,
      saved.libraryId,
      null,
      () => true,
    );
    const second = api.createUploadJournal(origin, credential, 'library-b', null, () => true);
    const other = api.createUploadJournal(
      origin,
      'generated-other-scope',
      saved.libraryId,
      null,
      () => true,
    );
    if (!first || !second || !other) throw new Error('IndexedDB was unavailable');
    const extra = {
      ...saved,
      credential,
      entries: saved.entries.map((entry) => ({ ...entry, requestCredential: credential })),
    };
    await first.save(extra, null);
    await second.save({ ...saved, libraryId: 'library-b' }, null);
    await other.save(saved, null);
    const readRows = () =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = indexedDB.open('ecs-upload-progress-v1', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['queues', 'revisions']);
          const rows: unknown[] = [];
          for (const name of ['queues', 'revisions']) {
            const all = tx.objectStore(name).getAll();
            all.onsuccess = () => rows.push(...all.result);
          }
          tx.oncomplete = () => {
            db.close();
            resolve(rows);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
    const before = await readRows();
    await api.clearCredentialUploads(origin, credential);
    const after = await readRows();
    const stale = await first.save(saved, null).then(
      () => false,
      () => true,
    );
    const cleared = await api
      .createUploadJournal(origin, credential, saved.libraryId, null, () => true)
      ?.read();
    return {
      privateStored: JSON.stringify(before).includes(credential),
      before: before.length,
      after: after.length,
      stale,
      cleared,
      other: !!(await other.read()),
    };
  }, snapshot());
  expect(result).toEqual({
    privateStored: false,
    before: 6,
    after: 2,
    stale: true,
    cleared: null,
    other: true,
  });
});

test('retired saves abort, malformed records require explicit discard and storage failures surface', async ({
  page,
}) => {
  const result = await page.evaluate(async (saved) => {
    const api = (window as unknown as { __uploadJournal: JournalModule }).__uploadJournal;
    const make = (current = () => true) => {
      const journal = api.createUploadJournal(
        location.origin,
        'generated-scope',
        saved.libraryId,
        null,
        current,
      );
      if (!journal) throw new Error('IndexedDB was unavailable');
      return journal;
    };
    let current = true;
    const old = make(() => current);
    const pending = old.save(saved, null);
    current = false;
    const stale = await pending.then(
      () => false,
      () => true,
    );
    const journal = make();
    const absent = await journal.read();
    await journal.save(saved, null);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('ecs-upload-progress-v1', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('queues', 'readwrite');
        const store = tx.objectStore('queues');
        const all = store.openCursor();
        all.onsuccess = () => {
          const cursor = all.result;
          if (cursor)
            cursor.update({ ...cursor.value, snapshot: { ...saved, libraryId: 'wrong-library' } });
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
    const invalid = await journal.read().then(
      () => false,
      () => true,
    );
    if (!journal.discard) throw new Error('Explicit discard unavailable');
    await journal.discard();
    const discarded = await journal.read();
    const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    try {
      Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
      const unavailable =
        api.createUploadJournal(
          location.origin,
          'generated-scope',
          saved.libraryId,
          null,
          () => true,
        ) === null;
      await api.clearCredentialUploads(location.origin, 'generated-scope');
      Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        value: {
          open() {
            throw new DOMException('Generated storage refusal', 'SecurityError');
          },
        },
      });
      const broken = make();
      const failure = await broken.read().then(
        () => '',
        (error) => error.name,
      );
      return { stale, absent, invalid, discarded, unavailable, failure };
    } finally {
      if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
      else Reflect.deleteProperty(window, 'indexedDB');
    }
  }, snapshot());
  expect(result).toEqual({
    stale: true,
    absent: null,
    invalid: true,
    discarded: null,
    unavailable: true,
    failure: 'SecurityError',
  });
});
