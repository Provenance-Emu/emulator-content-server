import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function blobPath(root: string, sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error('Blob address must be a lowercase SHA-256');
  return join(root, 'blobs', 'sha256', sha256.slice(0, 2), sha256);
}

export function virtualCachePath(root: string, containerSha256: string, entryId: string): string {
  if (!SHA256.test(containerSha256)) {
    throw new Error('Container address must be a lowercase SHA-256');
  }
  const key = createHash('sha256').update(`${containerSha256}:${entryId}`).digest('hex');
  return join(root, 'virtual-cache', key.slice(0, 2), key);
}

export function stagingFile(root: string, uploadId: string): string {
  if (!UPLOAD_ID.test(uploadId)) throw new Error('Upload id must be a UUID');
  return join(root, 'staging', uploadId);
}

export async function resolveInside(root: string, target: string): Promise<string> {
  const rootReal = await realpath(root);
  const absolute = resolve(root, target);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      await lstat(current);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      missing.push(basename(current));
      const parent = dirname(current);
      if (parent === current) throw new Error('Path escapes the data root');
      current = parent;
    }
  }
  const existingReal = await realpath(current);
  const rebuilt = missing.length === 0 ? existingReal : resolve(existingReal, ...missing.reverse());
  const rel = relative(rootReal, rebuilt);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error('Path escapes the data root');
  }
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
  if (rebuilt !== rootReal && !rebuilt.startsWith(rootPrefix)) {
    throw new Error('Path escapes the data root');
  }
  return rebuilt;
}
