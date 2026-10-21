import { open } from 'node:fs/promises';
import { DomainError } from '@ecs/domain';
export async function boundedFile(path: string, max: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > max)
      throw new DomainError(
        'matching-file-too-large',
        413,
        'This file exceeds the matching read limit',
      );
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new DomainError(
        'matching-file-changed',
        409,
        'File changed; scan its folder and try again',
      );
    return buffer;
  } finally {
    await handle.close();
  }
}
export function imageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (
    bytes.length >= 16 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  )
    return 'image/webp';
  return null;
}
