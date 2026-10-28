// SHA-256 works over ordinary LAN HTTP too, where Web Crypto may be unavailable.
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const READ_BYTES = 4 * 1024 * 1024;
const rotate = (word: number, bits: number) => (word >>> bits) | (word << (32 - bits));

/** One 64-byte tail and one message schedule, independent of the input size. */
class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly words = new Uint32Array(64);
  private readonly tail = new Uint8Array(64);
  private tailBytes = 0;
  private length = 0;

  update(bytes: Uint8Array): void {
    this.length += bytes.byteLength;
    if (!Number.isSafeInteger(this.length))
      throw new RangeError('File is too large to fingerprint');
    let offset = 0;
    if (this.tailBytes) {
      const count = Math.min(64 - this.tailBytes, bytes.byteLength);
      this.tail.set(bytes.subarray(0, count), this.tailBytes);
      this.tailBytes += count;
      offset = count;
      if (this.tailBytes === 64) {
        this.compress(this.tail, 0);
        this.tailBytes = 0;
      }
    }
    for (; offset + 64 <= bytes.byteLength; offset += 64) this.compress(bytes, offset);
    if (offset < bytes.byteLength) {
      this.tail.set(bytes.subarray(offset), this.tailBytes);
      this.tailBytes += bytes.byteLength - offset;
    }
  }

  finish(): string {
    const padded = new Uint8Array(this.tailBytes < 56 ? 64 : 128);
    padded.set(this.tail.subarray(0, this.tailBytes));
    padded[this.tailBytes] = 0x80;
    const view = new DataView(padded.buffer);
    // Encode the full 64-bit bit length without truncating the byte count to 32 bits.
    view.setUint32(padded.byteLength - 8, Math.floor(this.length / 0x20000000), false);
    view.setUint32(padded.byteLength - 4, (this.length % 0x20000000) * 8, false);
    this.compress(padded, 0);
    if (padded.byteLength === 128) this.compress(padded, 64);
    return Array.from(this.state, (word) => word.toString(16).padStart(8, '0')).join('');
  }

  // biome-ignore-start lint/style/noNonNullAssertion: The fixed 64-byte block and round bounds guarantee every indexed word.
  private compress(bytes: Uint8Array, offset: number): void {
    const words = this.words;
    for (let index = 0; index < 16; index++) {
      const at = offset + index * 4;
      words[index] =
        (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    }
    for (let index = 16; index < 64; index++) {
      const first = words[index - 15]!;
      const second = words[index - 2]!;
      const sigma0 = rotate(first, 7) ^ rotate(first, 18) ^ (first >>> 3);
      const sigma1 = rotate(second, 17) ^ rotate(second, 19) ^ (second >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;
    for (let index = 0; index < 64; index++) {
      const sigma1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first = (h + sigma1 + choose + ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const sigma0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }
  // biome-ignore-end lint/style/noNonNullAssertion: Fixed block and round bounds.
}

/** SHA-256 of UTF-8 text, encoded as lowercase hexadecimal. */
export function sha256Text(value: string): string {
  const hash = new Sha256();
  hash.update(new TextEncoder().encode(value));
  return hash.finish();
}

/** Hash every file byte without requiring Web Crypto or retaining a whole-file buffer. */
export async function fingerprintFile(
  blob: Blob,
  isCurrent?: () => boolean,
  onProgress?: (bytes: number, total: number) => void,
): Promise<string> {
  const check = () => {
    if (isCurrent && !isCurrent())
      throw new DOMException('File fingerprinting canceled', 'AbortError');
  };
  check();
  const total = blob.size;
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError('Invalid file size');
  const hash = new Sha256();
  onProgress?.(0, total);
  check();
  for (let offset = 0; offset < total; ) {
    check();
    const end = Math.min(offset + READ_BYTES, total);
    const bytes = await blob.slice(offset, end).arrayBuffer();
    check();
    if (bytes.byteLength !== end - offset) throw new Error('File changed while fingerprinting');
    hash.update(new Uint8Array(bytes));
    offset = end;
    onProgress?.(offset, total);
    check();
  }
  check();
  return hash.finish();
}
