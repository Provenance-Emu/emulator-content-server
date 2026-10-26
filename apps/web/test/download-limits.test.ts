import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedDownloadBlob } from '../src/lib/download-limits.js';

test('buffered ZIP fallback cancels oversized headers before collecting a body', async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        canceled = true;
      },
    }),
    { headers: { 'content-length': '9' } },
  );
  await assert.rejects(boundedDownloadBlob(response, 8), /256 MB/);
  assert.equal(canceled, true);
});

test('buffered ZIP fallback bounds chunked bodies without trusting a missing size', async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      pull(stream) {
        stream.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() {
        canceled = true;
      },
    }),
  );
  await assert.rejects(boundedDownloadBlob(response, 8), /256 MB/);
  assert.equal(canceled, true);
});

test('bounded blob fallback preserves all bytes for an ordinary download', async () => {
  const blob = await boundedDownloadBlob(new Response(new Uint8Array([1, 2, 3, 4])), 8);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
});
