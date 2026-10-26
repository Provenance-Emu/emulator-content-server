import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentClient, ContentError, type DownloadSink } from '../src/client.js';

function recordingSink() {
  const state = { bytes: [] as number[], resets: 0, closes: 0, aborts: [] as unknown[] };
  const sink: DownloadSink = {
    async write(chunk) {
      state.bytes.push(...chunk);
    },
    async reset() {
      state.resets++;
      state.bytes = [];
    },
    async close() {
      state.closes++;
    },
    async abort(reason) {
      state.aborts.push(reason);
    },
  };
  return { state, sink };
}
function body(parts: number[][], failure?: unknown) {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const part = parts[offset++];
        if (part) controller.enqueue(new Uint8Array(part));
        else if (failure) controller.error(failure);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}
const client = () => new ContentClient('https://content.example', 'generated-bearer');

for (const method of ['downloadTo', 'downloadSourceTo'] as const) {
  test(`${method} writes with backpressure and closes only after the final write`, async (t) => {
    let pulls = 0;
    let release = () => {};
    let started = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { sink, state } = recordingSink();
    const write = sink.write;
    sink.write = async (chunk) => {
      started();
      await held;
      await write(chunk);
    };
    t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
      assert.equal(
        String(url),
        `https://content.example/api/v1/${method === 'downloadTo' ? 'files' : 'sources'}/id%2Fpart/content`,
      );
      assert.ok(init);
      assert.equal(init.redirect, 'error');
      assert.equal(
        (init.headers as Record<string, string>).authorization,
        'Bearer generated-bearer',
      );
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (pulls++ < 3) controller.enqueue(new Uint8Array([pulls]));
              else controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-length': '3' } },
      );
    });
    const download = client()[method]('id/part', sink);
    await writing;
    assert.equal(pulls, 1, 'the client must await the sink before reading another chunk');
    assert.equal(state.closes, 0);
    release();
    await download;
    assert.deepEqual(state.bytes, [1, 2, 3]);
    assert.equal(state.resets, 1);
    assert.equal(state.closes, 1);
    assert.equal(state.aborts.length, 0);
  });

  for (const etag of ['"stable"', 'W/"weak"', undefined]) {
    test(`${method} ${etag === '"stable"' ? 'resumes' : 'resets'} interrupted bytes with ${etag ?? 'no validator'}`, async (t) => {
      const requests: Record<string, string>[] = [];
      t.mock.method(globalThis, 'fetch', async (_url: URL, init?: RequestInit) => {
        requests.push(init?.headers as Record<string, string>);
        if (requests.length === 1)
          return new Response(body([[1, 2]], new Error('connection lost')), {
            headers: { 'content-length': '4', ...(etag ? { etag } : {}) },
          });
        return etag === '"stable"'
          ? new Response(new Uint8Array([3, 4]), {
              status: 206,
              headers: { 'content-range': 'bytes 2-3/4', etag },
            })
          : new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-length': '4' } });
      });
      const { sink, state } = recordingSink();
      const progress: number[] = [];
      await client()[method]('id', sink, { onProgress: (received) => progress.push(received) });
      assert.deepEqual(state.bytes, [1, 2, 3, 4]);
      assert.equal(requests[1]?.range, etag === '"stable"' ? 'bytes=2-' : undefined);
      assert.equal(requests[1]?.['if-range'], etag === '"stable"' ? etag : undefined);
      assert.equal(state.resets, etag === '"stable"' ? 1 : 2);
      assert.equal(progress.at(-1), 4);
      assert.equal(state.closes, 1);
    });
  }

  test(`${method} discards the previous prefix when the server ignores Range`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () =>
      ++calls === 1
        ? new Response(body([[1, 2]], new Error('connection lost')), {
            headers: { 'content-length': '4', etag: '"old"' },
          })
        : new Response(new Uint8Array([8, 9, 10]), {
            headers: { 'content-length': '3', etag: '"new"' },
          }),
    );
    const { sink, state } = recordingSink();
    await client()[method]('id', sink);
    assert.deepEqual(state.bytes, [8, 9, 10]);
    assert.equal(state.resets, 2);
  });

  for (const changed of ['"new"', undefined]) {
    test(`${method} restarts from zero after a resumed response has ${changed ?? 'no validator'}`, async (t) => {
      const requests: Record<string, string>[] = [];
      t.mock.method(globalThis, 'fetch', async (_url: URL, init?: RequestInit) => {
        requests.push(init?.headers as Record<string, string>);
        if (requests.length === 1)
          return new Response(body([[1, 2]], new Error('connection lost')), {
            headers: { 'content-length': '4', etag: '"old"' },
          });
        if (requests.length === 2)
          return new Response(new Uint8Array([8, 9]), {
            status: 206,
            headers: { 'content-range': 'bytes 2-3/4', ...(changed ? { etag: changed } : {}) },
          });
        return new Response(new Uint8Array([6, 7, 8, 9]), {
          headers: { 'content-length': '4', etag: '"new"' },
        });
      });
      const { sink, state } = recordingSink();
      await client()[method]('id', sink);
      assert.deepEqual(state.bytes, [6, 7, 8, 9]);
      assert.equal(requests[2]?.range, undefined);
      assert.equal(state.resets, 2);
    });
  }

  for (const operation of ['write', 'reset', 'close'] as const) {
    test(`${method} never retries a failing sink ${operation} and preserves its error`, async (t) => {
      let calls = 0;
      const error = new Error('generated disk failure');
      t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return new Response(new Uint8Array([1, 2]));
      });
      const { sink, state } = recordingSink();
      sink[operation] = async () => {
        throw error;
      };
      await assert.rejects(client()[method]('id', sink), (actual) => actual === error);
      assert.equal(calls, operation === 'reset' ? 0 : 1);
      assert.deepEqual(state.aborts, [error]);
      assert.equal(state.closes, 0);
    });
  }

  for (const status of [302, 401, 403]) {
    test(`${method} aborts HTTP ${status} without retry or close`, async (t) => {
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return new Response(null, { status });
      });
      const { sink, state } = recordingSink();
      await assert.rejects(
        client()[method]('id', sink),
        (error) => error instanceof ContentError && error.status === status,
      );
      assert.equal(calls, 1);
      assert.equal(state.closes, 0);
      assert.equal(state.aborts.length, 1);
    });
  }

  test(`${method} passes cancellation to fetch and aborts a stalled body without close`, async (t) => {
    const abort = new AbortController();
    let cancelled = false;
    let calls = 0;
    const { sink, state } = recordingSink();
    const write = sink.write;
    sink.write = async (chunk) => {
      await write(chunk);
      abort.abort();
    };
    t.mock.method(globalThis, 'fetch', async (_url: URL, init?: RequestInit) => {
      calls++;
      assert.equal(init?.signal, abort.signal);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    await assert.rejects(client()[method]('id', sink, { signal: abort.signal }), {
      name: 'AbortError',
    });
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.equal(state.closes, 0);
    assert.equal(state.aborts.length, 1);
  });

  test(`${method} never retries an AbortError even without a supplied signal`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      throw new DOMException('Cancelled', 'AbortError');
    });
    const { sink, state } = recordingSink();
    await assert.rejects(client()[method]('id', sink), { name: 'AbortError' });
    assert.equal(calls, 1);
    assert.equal(state.closes, 0);
  });

  for (const response of [
    () =>
      new Response(new Uint8Array([1]), {
        status: 206,
        headers: { 'content-range': 'bytes 0-1/2' },
      }),
    () =>
      new Response(new Uint8Array([1, 2]), {
        status: 206,
        headers: { 'content-range': 'bytes 0-0/2' },
      }),
    () =>
      new Response(new Uint8Array([1]), {
        status: 206,
        headers: { 'content-range': 'bytes 1-1/2' },
      }),
    () => new Response(new Uint8Array([1, 2]), { headers: { 'content-length': '1' } }),
    () => new Response(null, { status: 204 }),
    () => new Response(null, { status: 304 }),
    () => new Response(null, { status: 416 }),
  ]) {
    test(`${method} rejects malformed, excessive or incomplete response ${response().status}:${response().headers.get('content-range') ?? response().headers.get('content-length')}`, async (t) => {
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return response();
      });
      const { sink, state } = recordingSink();
      await assert.rejects(
        client()[method]('id', sink),
        /range|length|size|complete|body|representation/i,
      );
      assert.equal(calls, 1);
      assert.equal(state.closes, 0);
      assert.equal(state.aborts.length, 1);
    });
  }
}

test('streaming large content never aggregates the body and bounds each sink write', async (t) => {
  let received = 0;
  let largest = 0;
  let closed = false;
  const part = new Uint8Array(512 * 1024);
  let chunks = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (chunks++ < 16) controller.enqueue(part);
              else controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-length': String(part.length * 16) } },
      ),
  );
  const sink: DownloadSink = {
    async write(chunk) {
      assert.equal(closed, false);
      largest = Math.max(largest, chunk.byteLength);
      received += chunk.byteLength;
    },
    async reset() {
      received = 0;
    },
    async close() {
      closed = true;
    },
    async abort() {
      assert.fail('complete transfer must not abort');
    },
  };
  await client().downloadTo('large', sink);
  assert.equal(received, 8 * 1024 * 1024);
  assert.ok(largest <= 64 * 1024);
  assert.equal(closed, true);
});

test('canceling a stalled read cancels the stream and aborts without close or retry', async (t) => {
  const controller = new AbortController();
  const reason = new Error('context retired');
  let cancelled = false;
  let calls = 0;
  let reading = () => {};
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            reading();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    );
  });
  const { sink, state } = recordingSink();
  const download = client().downloadTo('id', sink, { signal: controller.signal });
  await started;
  controller.abort(reason);
  await assert.rejects(download, (error) => error === reason);
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
  assert.equal(state.closes, 0);
  assert.deepEqual(state.aborts, [reason]);
});

test('a pre-aborted transfer does not fetch or reset an existing destination', async (t) => {
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('must not fetch');
  });
  const { sink, state } = recordingSink();
  await assert.rejects(client().downloadTo('id', sink, { signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(state.resets, 0);
  assert.equal(state.closes, 0);
  assert.equal(state.aborts.length, 1);
});

test('a reset failure after Range is ignored cancels the body and is never retried', async (t) => {
  let calls = 0;
  let cancelled = false;
  const error = new Error('could not truncate');
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1
      ? new Response(body([[1]], new Error('connection lost')), {
          headers: { 'content-length': '2', etag: '"stable"' },
        })
      : new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-length': '2' } },
        ),
  );
  const { sink, state } = recordingSink();
  const reset = sink.reset;
  sink.reset = async () => {
    if (state.resets) throw error;
    await reset();
  };
  await assert.rejects(client().downloadTo('id', sink), (actual) => actual === error);
  assert.equal(calls, 2);
  assert.equal(cancelled, true);
  assert.equal(state.closes, 0);
  assert.deepEqual(state.aborts, [error]);
});

test('a strong validator cannot silently change its representation size', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1
      ? new Response(body([[1]], new Error('connection lost')), {
          headers: { 'content-length': '3', etag: '"stable"' },
        })
      : new Response(new Uint8Array([2]), {
          status: 206,
          headers: { 'content-range': 'bytes 1-1/2', etag: '"stable"' },
        }),
  );
  const { sink, state } = recordingSink();
  await assert.rejects(client().downloadTo('id', sink), /size|validator/i);
  assert.equal(calls, 2);
  assert.equal(state.closes, 0);
  assert.deepEqual(state.bytes, [1]);
});

for (const declared of [true, false]) {
  test(`streaming rejects ${declared ? 'declared' : 'streamed'} content beyond maxBytes before writing it`, async (t) => {
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
        { headers: declared ? { 'content-length': '5' } : {} },
      );
    });
    const { sink, state } = recordingSink();
    await assert.rejects(client().downloadTo('id', sink, { maxBytes: 4 }), /limit|maximum/i);
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.deepEqual(state.bytes, []);
    assert.equal(state.closes, 0);
  });
}

test('a short full representation resumes its verified prefix before closing', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: URL, init?: RequestInit) => {
    if (++calls === 1)
      return new Response(new Uint8Array([1, 2]), {
        headers: { 'content-length': '4', etag: '"stable"' },
      });
    assert.ok(init);
    assert.equal((init.headers as Record<string, string>).range, 'bytes=2-');
    return new Response(new Uint8Array([3, 4]), {
      status: 206,
      headers: { 'content-range': 'bytes 2-3/4', etag: '"stable"' },
    });
  });
  const { sink, state } = recordingSink();
  await client().downloadTo('id', sink);
  assert.equal(calls, 2);
  assert.deepEqual(state.bytes, [1, 2, 3, 4]);
  assert.equal(state.closes, 1);
});

test('destination cleanup failures cannot replace an authorization refusal', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }));
  const { sink } = recordingSink();
  sink.abort = () => {
    throw new Error('cleanup failed synchronously');
  };
  await assert.rejects(
    client().downloadTo('id', sink),
    (error) => error instanceof ContentError && error.status === 403,
  );
});

test('legacy collected and raw downloads accept the same cancellation signal', async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: URL, init?: RequestInit) => {
    calls++;
    assert.equal(init?.signal, controller.signal);
    return new Response(new Uint8Array([1]));
  });
  await client().collect('id', { signal: controller.signal });
  const response = await client().download('id', { signal: controller.signal });
  await response.body?.cancel();
  assert.equal(calls, 2);
});

test('authorization refusal during resume aborts the partial destination instead of closing it', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1
      ? new Response(body([[1]], new Error('connection lost')), {
          headers: { 'content-length': '2', etag: '"stable"' },
        })
      : new Response(null, { status: 401 }),
  );
  const { sink, state } = recordingSink();
  await assert.rejects(
    client().downloadTo('id', sink),
    (error) => error instanceof ContentError && error.status === 401,
  );
  assert.equal(calls, 2);
  assert.equal(state.closes, 0);
  assert.equal(state.aborts.length, 1);
});

test('a throwing progress callback is a terminal consumer failure', async (t) => {
  let calls = 0;
  const failure = new Error('consumer retired');
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(new Uint8Array([1]));
  });
  const { sink, state } = recordingSink();
  await assert.rejects(
    client().downloadTo('id', sink, {
      onProgress() {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
  assert.equal(state.closes, 0);
  assert.deepEqual(state.aborts, [failure]);
});
