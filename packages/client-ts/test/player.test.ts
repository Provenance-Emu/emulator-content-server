import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentClient } from '../src/client.js';

const client = () => new ContentClient('https://content.example', 'fixture-bearer');

test('player reads use fixed authenticated paths and refuse redirects', async (t) => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (url.pathname === '/api/v1/player/core') return Response.json({ id: 'fceumm' });
    return new Response(
      url.pathname.endsWith('loader.js') ? 'export default 1' : new Uint8Array([0, 97, 115, 109]),
    );
  });
  assert.equal((await client().playerCore()).id, 'fceumm');
  const assets = await client().playerCoreAssets('fceumm');
  assert.equal(new TextDecoder().decode(assets.loader.bytes), 'export default 1');
  assert.deepEqual([...assets.wasm.bytes], [0, 97, 115, 109]);
  assert.deepEqual(
    requests.map((r) => r.url),
    [
      'https://content.example/api/v1/player/core',
      'https://content.example/play/cores/fceumm/loader.js',
      'https://content.example/play/cores/fceumm/core.wasm',
    ],
  );
  for (const { init } of requests) {
    assert.ok(init);
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer fixture-bearer');
    assert.equal(init?.redirect, 'error');
  }
});

test('invalid core IDs fail before a request and redirect responses fail closed', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://other.example' } });
  });
  await assert.rejects(client().playerCoreAssets('../secret'), /core|identifier/i);
  assert.equal(calls, 0);
  await assert.rejects(client().playerCoreAssets('fceumm'), /302|redirect/i);
});

function partial() {
  let reads = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2]));
      else controller.error(new Error('connection lost'));
    },
  });
}
for (const validator of ['"stable"', 'W/"weak"', null]) {
  test(`source collection resumes safely with ${validator ?? 'no validator'}`, async (t) => {
    let calls = 0;
    const headers: Record<string, string>[] = [];
    t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
      assert.equal(String(url), 'https://content.example/api/v1/sources/source%2Fid/content');
      headers.push(init?.headers as Record<string, string>);
      if (calls++ === 0)
        return new Response(partial(), {
          headers: { 'content-length': '4', ...(validator ? { etag: validator } : {}) },
        });
      if (validator === '"stable"')
        return new Response(new Uint8Array([3, 4]), {
          status: 206,
          headers: { 'content-range': 'bytes 2-3/4', etag: validator },
        });
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-length': '4' } });
    });
    const result = await client().collectSource('source/id', { maxBytes: 4 });
    assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
    assert.equal(headers[1]?.range, validator === '"stable"' ? 'bytes=2-' : undefined);
    assert.equal(headers[1]?.['if-range'], validator === '"stable"' ? validator : undefined);
    assert.equal(headers[1]?.authorization, 'Bearer fixture-bearer');
  });
}
for (const stated of [true, false]) {
  test(`source cap cancels ${stated ? 'declared' : 'streamed'} oversized bodies without retry`, async (t) => {
    let cancelled = false;
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(5));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: stated ? { 'content-length': '5' } : {} },
      );
    });
    await assert.rejects(client().collectSource('source', { maxBytes: 4 }), /limit|maximum|large/i);
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  });
}

test('a changed source restarts instead of appending the previous revision', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (calls++ === 0)
      return new Response(partial(), { headers: { 'content-length': '4', etag: '"old"' } });
    return new Response(new Uint8Array([7, 8, 9]), {
      headers: { 'content-length': '3', etag: '"new"' },
    });
  });
  const result = await client().collectSource('source', { maxBytes: 4 });
  assert.deepEqual([...result.bytes], [7, 8, 9]);
  assert.equal(result.etag, '"new"');
});

for (const headers of [
  { 'content-length': '-1' },
  { 'content-length': 'not-a-size' },
  { 'content-range': 'bytes 1-2/2', etag: '"stable"' },
] as Array<Record<string, string>>) {
  test(`malformed transfer metadata cannot become collected bytes: ${JSON.stringify(headers)}`, async (t) => {
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(new Uint8Array([1, 2]), {
          status: 'content-range' in headers ? 206 : 200,
          headers,
        }),
    );
    await assert.rejects(
      client().collectSource('source', { attempts: 1, maxBytes: 4 }),
      /size|range|length/i,
    );
  });
}

test('a resumed source rejects a mismatched response validator', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (calls++ === 0)
      return new Response(partial(), { headers: { 'content-length': '4', etag: '"old"' } });
    return new Response(new Uint8Array([8, 9]), {
      status: 206,
      headers: { 'content-range': 'bytes 2-3/4', etag: '"new"' },
    });
  });
  await assert.rejects(
    client().collectSource('source', { attempts: 2, maxBytes: 4 }),
    /validator|changed/i,
  );
});

test('core assets enforce their own loader cap and cancel before reading', async (t) => {
  let cancelled = false;
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-length': '8388609' } },
      ),
  );
  await assert.rejects(client().playerCoreAssets('fceumm'), /limit|maximum|large/i);
  assert.equal(cancelled, true);
});

test('the asset collector enforces the same explicit memory budget', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(5)));
  await assert.rejects(
    client().collect('asset', Object.assign({ attempts: 1 }, { maxBytes: 4 })),
    /limit|maximum|large/i,
  );
});
