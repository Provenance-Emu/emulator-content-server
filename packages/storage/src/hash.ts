import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

export function crc32(buffer: Buffer, seed = 0xffffffff): number {
  let crc = seed >>> 0;
  for (const byte of buffer) {
    const entry = CRC_TABLE[(crc ^ byte) & 0xff];
    if (entry === undefined) throw new Error('CRC table miss');
    crc = (entry ^ (crc >>> 8)) >>> 0;
  }
  return crc >>> 0;
}

export function crc32Hex(buffer: Buffer): string {
  return ((crc32(buffer) ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

export interface ContentHash {
  sha256: string;
  md5: string;
  crc: string;
  size: number;
}

export async function hashFile(filePath: string): Promise<ContentHash> {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let crc = 0xffffffff;
  let size = 0;
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sha256.update(buffer);
    md5.update(buffer);
    crc = crc32(buffer, crc);
    size += buffer.length;
  }
  return {
    sha256: sha256.digest('hex'),
    md5: md5.digest('hex'),
    crc: ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0'),
    size,
  };
}
