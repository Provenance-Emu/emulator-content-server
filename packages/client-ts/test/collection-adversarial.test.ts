import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentClient } from '../src/client.js';

for (const method of ['collectSource', 'collect'] as const) {
  for (const status of [304, 416]) {
    test(`${method} rejects HTTP ${status} without a complete cached representation`, async (t) => {
      t.mock.method(globalThis, 'fetch', async () => new Response(null, { status }));
      const client = new ContentClient('https://content.example');
      await assert.rejects(client[method]('id', { attempts: 1 }), /complete|body|representation/i);
    });
  }

  for (const declaredLength of [undefined, '1']) {
    test(`${method} cancels body bytes beyond the declared range${declaredLength ? ' and length' : ''}`, async (t) => {
      let cancelled = false;
      let reads = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const index = reads++;
            if (declaredLength && index < 2) controller.enqueue(new Uint8Array([index + 1]));
            else if (!declaredLength && index === 0) controller.enqueue(new Uint8Array([1, 2]));
            else controller.close();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      t.mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(body, {
            status: 206,
            headers: {
              'content-range': 'bytes 0-0/2',
              ...(declaredLength ? { 'content-length': declaredLength } : {}),
            },
          }),
      );
      const client = new ContentClient('https://content.example');
      await assert.rejects(client[method]('id', { attempts: 1 }), /range|length/i);
      assert.equal(cancelled, true, 'the unread remainder must be canceled');
      assert.equal(
        reads,
        declaredLength ? 2 : 1,
        'oversized data must fail before reading another chunk',
      );
    });
  }

  test(`${method} rejects a completed body shorter than its declared range without retry`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response(new Uint8Array([1]), {
        status: 206,
        headers: { 'content-range': 'bytes 0-1/2', etag: '"same"' },
      });
    });
    const client = new ContentClient('https://content.example');
    await assert.rejects(client[method]('id'), /range|length/i);
    assert.equal(calls, 1);
  });

  test(`${method} still resumes a broken stream with a matching strong range validator`, async (t) => {
    const requests: Record<string, string>[] = [];
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (_url: URL, init?: RequestInit) => {
      requests.push(init?.headers as Record<string, string>);
      if (requests.length === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2]));
              else controller.error(new Error('fixture connection loss'));
            },
          }),
          { headers: { 'content-length': '4', etag: '"same"' } },
        );
      }
      return new Response(new Uint8Array([3, 4]), {
        status: 206,
        headers: { 'content-range': 'bytes 2-3/4', etag: '"same"' },
      });
    });
    const client = new ContentClient('https://content.example');
    const result = await client[method]('id', { maxBytes: 4 });
    assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
    assert.equal(requests[1]?.range, 'bytes=2-');
    assert.equal(requests[1]?.['if-range'], '"same"');
  });
}
