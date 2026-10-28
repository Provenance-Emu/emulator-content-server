import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fingerprintFile, sha256Text } from '../src/lib/file-fingerprint.js';

const chunkBytes = 4 * 1024 * 1024;
function generated(size: number) {
  return Uint8Array.from({ length: size }, (_, index) => (index * 31 + (index >>> 8)) & 255);
}
const reference = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

test('text SHA-256 matches standard vectors and UTF-8 including replacement characters', () => {
  for (const [input, expected] of [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ] as const)
    assert.equal(sha256Text(input), expected);
  for (const value of ['Café 日本語 🎮', '\ud800 replacement \udfff', 'e\u0301']) {
    assert.equal(sha256Text(value), reference(value));
  }
});

test('file fingerprints match Node SHA-256 around block and padding boundaries', async () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 4095, 4096]) {
    const bytes = generated(size);
    assert.equal(await fingerprintFile(new Blob([bytes])), reference(bytes), `size ${size}`);
  }
});

test('large files use bounded slice reads and report progress without Web Crypto', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  });
  const bytes = generated(chunkBytes * 2 + 65);
  const reads: number[] = [];
  class ObservedBlob extends Blob {
    override async arrayBuffer(): Promise<ArrayBuffer> {
      assert.fail('must not read the complete blob');
    }
    override slice(start = 0, end = this.size, type?: string): Blob {
      reads.push(end - start);
      return super.slice(start, end, type);
    }
  }
  const progress: number[] = [];
  const blob = new ObservedBlob([bytes]);
  const hash = await fingerprintFile(blob, undefined, (received, total) => {
    assert.equal(total, blob.size);
    assert.ok(received >= (progress.at(-1) ?? 0));
    progress.push(received);
  });
  assert.equal(hash, reference(bytes));
  assert.deepEqual(reads, [chunkBytes, chunkBytes, 65]);
  assert.equal(progress.at(-1), bytes.length);
  assert.equal(globalThis.crypto, undefined);
});

test('retired lifetimes stop before reads and reject a completed stale read', async () => {
  let reads = 0;
  let current = true;
  class RetiringBlob extends Blob {
    override slice(start = 0, end = this.size, type?: string): Blob {
      reads++;
      const part = super.slice(start, end, type);
      const read = part.arrayBuffer.bind(part);
      part.arrayBuffer = async () => {
        const result = await read();
        current = false;
        return result;
      };
      return part;
    }
  }
  const blob = new RetiringBlob([new Uint8Array(chunkBytes + 1)]);
  await assert.rejects(
    fingerprintFile(blob, () => false),
    { name: 'AbortError' },
  );
  assert.equal(reads, 0);
  await assert.rejects(
    fingerprintFile(blob, () => current),
    { name: 'AbortError' },
  );
  assert.equal(reads, 1, 'a stale chunk must prevent the next read');
  current = true;
  await assert.rejects(
    fingerprintFile(
      new Blob(),
      () => current,
      () => {
        current = false;
      },
    ),
    { name: 'AbortError' },
  );
});

test('reselection identifies the full bytes rather than file size, name or timestamp', async () => {
  const bytes = generated(chunkBytes * 2 + 65);
  const changed = bytes.slice();
  changed[chunkBytes + 31] = (changed[chunkBytes + 31] ?? 0) ^ 1;
  const first = new File([bytes], 'same.bin', { lastModified: 1 });
  const different = new File([changed], 'same.bin', { lastModified: 1 });
  assert.equal(first.size, different.size);
  assert.notEqual(await fingerprintFile(first), await fingerprintFile(different));
  assert.equal(
    await fingerprintFile(first),
    await fingerprintFile(new File([bytes], 'renamed.bin', { lastModified: 2 })),
  );
});
