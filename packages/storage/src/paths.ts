import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DomainError } from '@ecs/domain';

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

/**
 * Resolves an operator-supplied directory for use as a read-only content root.
 * The real path is recorded so a later symlink swap cannot redirect reads, and a
 * root may neither sit inside the data directory nor overlap one already saved,
 * because overlapping roots would double-count the same file.
 */
export async function resolveContentRoot(
  dataDir: string,
  candidate: string,
  existing: readonly string[],
): Promise<string> {
  if (!isAbsolute(candidate)) {
    throw new DomainError('invalid-root', 400, 'A content root must be an absolute path');
  }
  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new DomainError('invalid-root', 400, 'That folder does not exist');
  }
  if (!(await stat(target)).isDirectory()) {
    throw new DomainError('invalid-root', 400, 'A content root must be a directory');
  }
  const data = await realpath(dataDir);
  if (pathsOverlap(data, target)) {
    throw new DomainError(
      'invalid-root',
      400,
      'A content root must stay outside the data directory',
    );
  }
  for (const saved of existing) {
    if (pathsOverlap(saved, target)) {
      throw new DomainError('conflict', 409, `That folder overlaps the saved root ${saved}`);
    }
  }
  return target;
}

/**
 * Resolves a directory that will hold blobs. The real path is recorded, the
 * directory stays outside the data directory, and it may not overlap a location
 * or a content root, because those trees are read for different reasons.
 */
export async function resolveStorageLocation(
  dataDir: string,
  candidate: string,
  existing: readonly string[],
  contentRoots: readonly string[] = [],
): Promise<string> {
  if (!isAbsolute(candidate)) {
    throw new DomainError('invalid-location', 400, 'A storage location must be an absolute path');
  }
  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new DomainError('invalid-location', 400, 'That folder does not exist');
  }
  if (!(await stat(target)).isDirectory()) {
    throw new DomainError('invalid-location', 400, 'A storage location must be a directory');
  }
  const data = await realpath(dataDir);
  if (pathsOverlap(data, target)) {
    throw new DomainError(
      'invalid-location',
      400,
      'A storage location must stay outside the data directory',
    );
  }
  for (const saved of existing) {
    if (pathsOverlap(saved, target)) {
      throw new DomainError('conflict', 409, `That folder overlaps the saved location ${saved}`);
    }
  }
  for (const root of contentRoots) {
    if (pathsOverlap(root, target)) {
      throw new DomainError('conflict', 409, `That folder overlaps the content root ${root}`);
    }
  }
  return target;
}

/** True when two directories are the same or one contains the other. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || contains(a, b) || contains(b, a);
}

function contains(parent: string, child: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(prefix);
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
