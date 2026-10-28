import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sha256Bytes, sha256Hex } from '../src/sha256.js';

test('LAN HTTP SHA-256 matches standard vectors across padding and block boundaries', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1024]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
  }
});

test('integrity helper still verifies bytes when Web Crypto is unavailable on LAN HTTP', async (t) => {
  t.mock.getter(globalThis, 'crypto', () => undefined as unknown as typeof globalThis.crypto);
  const bytes = new TextEncoder().encode('abc');
  assert.equal(
    await sha256Bytes(bytes),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
