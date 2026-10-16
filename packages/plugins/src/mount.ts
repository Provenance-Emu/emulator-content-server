import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { RemoteObject, StorageConnector } from './connector.js';
import { PluginError } from './errors.js';
import { classify, type KindRule } from './kinds.js';
import { hiddenPath, safeRelativePath } from './paths.js';

export async function openMount(input: {
  id: string;
  scheme: string;
  root: string;
  ignoreHidden: boolean;
  kinds: readonly KindRule[];
}): Promise<StorageConnector> {
  const root = await realpath(input.root).catch(() => {
    throw new PluginError('offline', `${input.scheme} root ${input.root} is not available`);
  });
  const info = await stat(root);
  if (!info.isDirectory()) {
    throw new PluginError('offline', `${input.scheme} root is not a directory`);
  }
  return {
    id: input.id,
    scheme: input.scheme,
    writable: true,
    list: () => listTree(root, input.ignoreHidden, input.kinds),
    read: async (object, start, endInclusive) => {
      const path = await inside(root, object.relativePath);
      return readRange(path, start, endInclusive);
    },
    put: async (relativePath, bytes) => {
      const path = await inside(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(path, bytes, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new PluginError('already-present', `${relativePath} is already on the connector`);
        }
        throw error;
      }
    },
  };
}

async function listTree(
  root: string,
  ignoreHidden: boolean,
  kinds: readonly KindRule[],
): Promise<RemoteObject[]> {
  const objects: RemoteObject[] = [];
  await walk(root, root, ignoreHidden, kinds, objects);
  objects.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return objects;
}

async function walk(
  root: string,
  directory: string,
  ignoreHidden: boolean,
  kinds: readonly KindRule[],
  objects: RemoteObject[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const relativePath = relative(root, absolute).split(sep).join('/');
    if (ignoreHidden && hiddenPath(relativePath)) continue;
    if (entry.isSymbolicLink()) {
      throw new PluginError('path-escape', `${relativePath} is a symlink`);
    }
    if (entry.isDirectory()) {
      await walk(root, absolute, ignoreHidden, kinds, objects);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(absolute);
    objects.push({
      relativePath: safeRelativePath(relativePath),
      locator: relativePath,
      size: info.size,
      sha256: await hashFile(absolute),
      kind: classify(relativePath, kinds),
    });
  }
}

/**
 * The real path has to stay under the root. A symlink was already refused at
 * listing time; this is the check on the way back out, so a path that appears
 * between the list and the read cannot be followed either.
 */
async function inside(root: string, relativePath: string): Promise<string> {
  const safe = safeRelativePath(relativePath);
  const absolute = join(root, ...safe.split('/'));
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      await lstat(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(basename(current));
      const parent = dirname(current);
      if (parent === current) {
        throw new PluginError('path-escape', `${relativePath} leaves the connector root`);
      }
      current = parent;
    }
  }
  const existing = await realpath(current);
  const rebuilt = missing.length === 0 ? existing : join(existing, ...missing.reverse());
  const rel = relative(root, rebuilt);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new PluginError('path-escape', `${relativePath} leaves the connector root`);
  }
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (rebuilt !== root && !rebuilt.startsWith(prefix)) {
    throw new PluginError('path-escape', `${relativePath} leaves the connector root`);
  }
  return rebuilt;
}

async function readRange(path: string, start: number, endInclusive: number): Promise<Uint8Array> {
  if (start < 0 || endInclusive < start) throw new PluginError('bad-range', 'Range is empty');
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new PluginError('bad-range', 'Range target is not a file');
    if (endInclusive >= info.size)
      throw new PluginError('bad-range', 'Range extends past the file');
    const length = endInclusive - start + 1;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead !== length) throw new PluginError('bad-range', 'The file ended inside the range');
    return new Uint8Array(buffer);
  } finally {
    await handle.close();
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}
