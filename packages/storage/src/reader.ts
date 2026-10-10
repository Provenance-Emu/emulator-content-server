import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type { ContentReader } from '@ecs/domain';

export class FileContentReader implements ContentReader {
  constructor(
    private readonly filePath: string,
    private readonly size: number,
  ) {}

  stat(): { size: number } {
    return { size: this.size };
  }

  openFull(): Readable {
    return createReadStream(this.filePath, { highWaterMark: 1024 * 1024 });
  }

  openRange(start: number, endInclusive: number): Readable {
    return createReadStream(this.filePath, {
      start,
      end: endInclusive,
      highWaterMark: 1024 * 1024,
    });
  }
}
