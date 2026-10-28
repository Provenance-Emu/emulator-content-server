import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import {
  parseUploadCheckpoint,
  type UploadCheckpoint,
  type UploadCheckpointRecord,
  type UploadJournal,
} from '../src/lib/upload-checkpoint.js';
import { createUploadQueue } from '../src/lib/upload-queue.js';
import { createUploadReview } from '../src/lib/upload-review.js';
import { asset, item, transport } from './library-browser-fixture.js';
import { deferred } from './lifecycle-fixture.js';

function journal() {
  let record: UploadCheckpointRecord | null = null;
  let generation = 0;
  const history: UploadCheckpoint[] = [];
  const store: UploadJournal = {
    async read() {
      return structuredClone(record);
    },
    async save(snapshot, expected) {
      assert.equal(record?.revision ?? null, expected, 'journal ownership must remain current');
      const checked = parseUploadCheckpoint(snapshot, 'library', null);
      history.push(structuredClone(checked));
      record = { revision: ++generation, snapshot: structuredClone(checked) };
      return generation;
    },
    async remove(expected) {
      assert.equal(record?.revision, expected);
      record = null;
    },
  };
  return { store, history };
}
function files() {
  const review = createUploadReview({
    libraryId: 'library',
    item: null,
    systems: [{ identifier: 'com.provenance.nes', name: 'NES' }],
  });
  review.selectFiles([new File([new Uint8Array([1, 2, 3, 4])], 'first.nes')]);
  return review.validate() ?? [];
}

test('reload recovery retains transfer identity and rejects changed bytes before any upload', async (t) => {
  const saved = journal();
  let failing = true;
  let creates = 0;
  const keys: string[] = [];
  const bases: number[] = [];
  const f = transport((url, init) => {
    if (url.pathname === '/api/v1/items') {
      assert.equal(saved.history.at(-1)?.entries[0]?.phase, 'creating');
      creates++;
      return Response.json(item());
    }
    if (url.pathname === '/api/v1/uploads') {
      keys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      assert.equal(saved.history.at(-1)?.entries[0]?.baseRevision, 7);
      if (failing) return Response.json({}, { status: 503 });
      return Response.json({ id: 'transfer' });
    }
    if (url.pathname.endsWith('/transfer'))
      return Response.json({ id: 'transfer', state: 'open', received: 0 });
    if (url.pathname.endsWith('/content')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/complete')) {
      bases.push(JSON.parse(String(init?.body)).baseRevision);
      return Response.json(asset());
    }
    throw new Error('Unexpected request');
  });
  t.after(f.restore);
  const first = createUploadQueue(f.client, { libraryId: 'library', journal: saved.store });
  await first.start(files(), true);
  const checkpoint = await saved.store.read();
  assert.ok(checkpoint);
  assert.equal(checkpoint.snapshot.entries[0]?.phase, 'failed');
  assert.equal(JSON.stringify(checkpoint).includes('"body"'), false);
  assert.equal(JSON.stringify(checkpoint).includes('"file"'), false);
  first.dispose();
  const recovered = createUploadQueue(f.client, { libraryId: 'library', journal: saved.store });
  recovered.restore(checkpoint);
  const before = f.requests.length;
  await recovered.attachFiles([new File([new Uint8Array([4, 3, 2, 1])], 'first.nes')]);
  await recovered.retryUnfinished();
  assert.equal(f.requests.length, before);
  assert.equal(get(recovered).entries[0]?.file, null);
  const original = files()[0];
  assert.ok(original);
  await recovered.attachFiles([original.file]);
  failing = false;
  await recovered.retryUnfinished();
  assert.equal(creates, 1);
  assert.equal(keys[1], keys[0]);
  assert.deepEqual(bases, [7]);
  assert.equal(get(recovered).entries[0]?.state, 'succeeded');
  assert.equal(await saved.store.read(), null);
});

test('a crash during creation restores reconciliation instead of issuing another item POST', async (t) => {
  const saved = journal();
  const pending = deferred<Response>();
  const requested = deferred<void>();
  let creates = 0;
  const f = transport(() => {
    creates++;
    requested.resolve();
    return pending.promise;
  });
  t.after(f.restore);
  const first = createUploadQueue(f.client, { libraryId: 'library', journal: saved.store });
  const started = first.start(files(), true);
  await requested.promise;
  const checkpoint = await saved.store.read();
  assert.ok(checkpoint);
  assert.equal(checkpoint.snapshot.entries[0]?.phase, 'creating');
  first.dispose();
  pending.resolve(Response.json(item()));
  await started;
  const recovered = createUploadQueue(f.client, { libraryId: 'library', journal: saved.store });
  recovered.restore(checkpoint);
  const original = files()[0];
  assert.ok(original);
  await recovered.attachFiles([original.file]);
  await recovered.retryUnfinished();
  assert.equal(creates, 1);
  assert.equal(get(recovered).entries[0]?.state, 'reconciliation-required');
});

test('failed write-ahead storage stops before creating a game or sending file bytes', async (t) => {
  const saved = journal();
  let checkpoints = 0;
  const blocked = {
    ...saved.store,
    async save(snapshot: UploadCheckpoint, expected: number | null) {
      if (++checkpoints === 2) throw new Error('Generated storage failure');
      return saved.store.save(snapshot, expected);
    },
  };
  const f = transport(() => {
    throw new Error('No HTTP request is permitted');
  });
  t.after(f.restore);
  const q = createUploadQueue(f.client, { libraryId: 'library', journal: blocked });
  await q.start(files(), true);
  assert.equal(f.requests.length, 0);
  assert.match(get(q).failure ?? '', /Generated storage failure/);
});

test('checkpoint validation rejects cross-library targets and unsafe persisted paths', async () => {
  const saved = journal();
  const f = transport((url) =>
    url.pathname === '/api/v1/items' ? Response.json(item()) : Response.json({}, { status: 503 }),
  );
  try {
    const q = createUploadQueue(f.client, { libraryId: 'library', journal: saved.store });
    await q.start(files(), true);
    const checkpoint = await saved.store.read();
    assert.ok(checkpoint);
    const wrong = structuredClone(checkpoint.snapshot);
    const target = wrong.entries[0]?.target;
    assert.ok(target);
    target.libraryId = 'other';
    assert.throws(() => parseUploadCheckpoint(wrong, 'library', null), /target/);
    const path = structuredClone(checkpoint.snapshot);
    const row = path.entries[0];
    assert.ok(row);
    row.relativePath = '../outside';
    assert.throws(() => parseUploadCheckpoint(path, 'library', null), /invalid/);
  } finally {
    f.restore();
  }
});
