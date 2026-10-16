import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function ensureLayout(root: string): Promise<void> {
  for (const name of ['blobs/sha256', 'staging', 'virtual-cache', 'backups']) {
    await mkdir(join(root, name), { recursive: true });
  }
}

/** A secondary location stores blobs only. Staging and the virtual cache stay in the data directory. */
export async function ensureBlobStore(root: string): Promise<void> {
  await mkdir(join(root, 'blobs', 'sha256'), { recursive: true });
}

/**
 * Online means the blob directory is present. An unplugged drive that leaves an
 * empty mount point has no `blobs/` directory, so it is offline rather than empty.
 */
export async function locationOnline(root: string): Promise<boolean> {
  try {
    return (await stat(join(root, 'blobs'))).isDirectory();
  } catch {
    return false;
  }
}
