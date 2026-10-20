import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentClient } from '../src/client.js';

const request = {
  libraryId: 'library',
  itemId: 'item',
  kind: 'battery_save',
  displayName: 'generated',
  relativePath: 'generated.sav',
  baseRevision: 7,
  body: new Uint8Array([1, 2, 3, 4, 5, 6]),
  idempotencyKey: 'stable-save',
};
for (const received of [3, 6]) {
  test(`a replayed opening receipt uses live offset ${received} before transfer/completion`, async (t) => {
    const puts: { range: string; bytes: Uint8Array }[] = [];
    const keys: string[] = [];
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (input: URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/uploads')) {
        keys.push(new Headers(init.headers).get('idempotency-key') ?? '');
        return Response.json({ id: 'upload', received: 0, state: 'open' }, { status: 201 });
      }
      if (!init?.method && url.endsWith('/uploads/upload')) {
        reads += 1;
        return Response.json({
          id: 'upload',
          received,
          state: received === 6 ? 'completed' : 'open',
        });
      }
      if (init?.method === 'PUT') {
        puts.push({
          range: new Headers(init.headers).get('content-range') ?? '',
          bytes: new Uint8Array(init.body as Uint8Array),
        });
        return new Response(null, { status: 204 });
      }
      assert.ok(url.endsWith('/uploads/upload/complete'));
      keys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      assert.equal(JSON.parse(String(init?.body)).baseRevision, 7);
      return Response.json({ id: 'existing-asset' });
    });
    const asset = await new ContentClient('https://content.invalid').upload(request);
    assert.equal(asset.id, 'existing-asset');
    assert.equal(reads, 1);
    assert.deepEqual(keys, ['stable-save.open', 'stable-save.done']);
    assert.deepEqual(
      puts,
      received === 3 ? [{ range: 'bytes 3-5/6', bytes: new Uint8Array([4, 5, 6]) }] : [],
    );
  });
}
for (const received of [-1, 1.5, 7]) {
  test(`invalid live offset ${received} fails before writing bytes or committing`, async (t) => {
    let writes = 0;
    t.mock.method(globalThis, 'fetch', async (_input: URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (!String(_input).endsWith('/uploads')) writes += 1;
        return Response.json({ id: 'upload', received: 0, state: 'open' });
      }
      if (init?.method === 'PUT') writes += 1;
      return Response.json({ id: 'upload', received, state: 'open' });
    });
    await assert.rejects(new ContentClient('https://content.invalid').upload(request), /offset/i);
    assert.equal(writes, 0);
  });
}
