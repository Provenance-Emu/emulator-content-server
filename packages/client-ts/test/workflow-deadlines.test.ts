import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ContentClient } from '../src/client.js';

for (const mode of ['deadline', 'shutdown'] as const) {
  test(`workflow HTTP ${mode} interrupts a stalled response body`, async (t) => {
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const signal = init.signal;
      assert.ok(signal);
      return new Response(
        new ReadableStream({
          start(stream) {
            signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
          },
        }),
      );
    });
    const client = new ContentClient('http://127.0.0.1:8473', 'generated', {
      signal: controller.signal,
      timeoutMs: 25,
    });
    const pending = client.claimWorkflowRun();
    if (mode === 'shutdown') controller.abort();
    await Promise.all([assert.rejects(pending, /abort|timeout/i), delay(40)]);
  });
}
