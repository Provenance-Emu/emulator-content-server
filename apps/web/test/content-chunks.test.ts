import assert from 'node:assert/strict';
import test from 'node:test';
import { CHUNK_BYTES, chunkSink } from '../src/player/content-chunks.js';

const pattern = (size: number) => Uint8Array.from({ length: size }, (_, index) => index % 251);

test('a download is kept as full pieces and one ragged last piece, byte for byte', async () => {
  const size = CHUNK_BYTES * 2 + 1234;
  const whole = pattern(size);
  const pieces = chunkSink(size);
  // Arrives in sizes that never line up with a piece boundary.
  for (let at = 0; at < size; at += 1_000_003)
    await pieces.sink.write(whole.subarray(at, Math.min(size, at + 1_000_003)));
  await pieces.sink.close();
  const { parts } = pieces.result();
  assert.deepEqual(
    parts.map((part) => part.byteLength),
    [CHUNK_BYTES, CHUNK_BYTES, 1234],
  );
  // Each piece owns its buffer, so it can be handed to the emulator without a copy.
  for (const part of parts) assert.equal(part.buffer.byteLength, part.byteLength);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  assert.deepEqual(joined, whole);
});

test('a restarted download starts again from nothing', async () => {
  const pieces = chunkSink(10);
  await pieces.sink.write(new Uint8Array(7).fill(9));
  await pieces.sink.reset();
  await pieces.sink.write(pattern(10));
  await pieces.sink.close();
  assert.deepEqual(pieces.result().parts, [pattern(10)]);
});

test('a short or oversized download is refused instead of handed to the emulator', async () => {
  const short = chunkSink(10);
  await short.sink.write(new Uint8Array(9));
  await assert.rejects(short.sink.close(), /before the whole file arrived/);
  assert.throws(() => short.result(), /not finished/);
  const long = chunkSink(10);
  await assert.rejects(long.sink.write(new Uint8Array(11)), /more than the file/);
});
