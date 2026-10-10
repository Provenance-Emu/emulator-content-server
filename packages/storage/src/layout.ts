import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function ensureLayout(root: string): Promise<void> {
  for (const name of ['blobs/sha256', 'staging', 'virtual-cache', 'backups']) {
    await mkdir(join(root, name), { recursive: true });
  }
}
