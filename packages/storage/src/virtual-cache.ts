import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DomainError, type VirtualEntry } from '@ecs/domain';
import { blobPath, virtualCachePath } from './paths.js';
import type { VirtualProviderRegistry } from './virtual.js';

const MAX_EXPANSIONS = 4;

export interface VirtualEntryBytes {
  format: string;
  path: string;
  offset: number;
  size: number;
  logicalPath: string;
}

// Each hop through a stored container is a window into the same blob. Only a
// compressed container costs an expansion, so the loop pays once per paid hop.
export async function openVirtualEntry(
  root: string,
  containerSha256: string,
  registry: VirtualProviderRegistry,
  entryId: string,
  cacheRoot = root,
): Promise<VirtualEntryBytes | null> {
  let file = blobPath(root, containerSha256);
  let id = entryId;
  let prefix = '';
  let logical = '';
  for (let hop = 0; hop < MAX_EXPANSIONS; hop += 1) {
    const located = await registry.resolve(file, id);
    if (!located) return null;
    const { format, resolution } = located;
    if (resolution.kind === 'range') {
      return {
        format,
        path: file,
        offset: resolution.offset,
        size: resolution.entry.uncompressedSize,
        logicalPath: `${logical}${resolution.entry.path}`,
      };
    }
    const absolute = prefix === '' ? resolution.entryId : `${prefix}.${resolution.entryId}`;
    const expanded = await expand(
      cacheRoot,
      containerSha256,
      registry,
      format,
      file,
      resolution.entryId,
      absolute,
    );
    if (resolution.remainder === null) {
      return {
        format,
        path: expanded.path,
        offset: 0,
        size: expanded.size,
        logicalPath: `${logical}${resolution.path}`,
      };
    }
    file = expanded.path;
    id = resolution.remainder;
    prefix = absolute;
    logical = `${logical}${resolution.path}/`;
  }
  throw new DomainError('archive-rejected', 422, 'Archive entry needs too many expansions');
}

export async function listVirtualEntries(
  root: string,
  containerSha256: string,
  registry: VirtualProviderRegistry,
  within?: string,
  cacheRoot = root,
): Promise<{ format: string; entries: VirtualEntry[] } | null> {
  const container = blobPath(root, containerSha256);
  if (within === undefined) return registry.inspect(container);
  const bytes = await openVirtualEntry(root, containerSha256, registry, within, cacheRoot);
  if (!bytes) return null;
  const inspected = await registry.inspect(bytes.path, {
    offset: bytes.offset,
    length: bytes.size,
  });
  if (!inspected) return null;
  return {
    format: inspected.format,
    entries: inspected.entries.map((entry) => ({
      ...entry,
      entryId: `${within}.${entry.entryId}`,
      path: `${bytes.logicalPath}/${entry.path}`,
    })),
  };
}

async function expand(
  root: string,
  containerSha256: string,
  registry: VirtualProviderRegistry,
  format: string,
  filePath: string,
  entryId: string,
  cacheId: string,
): Promise<{ path: string; size: number }> {
  const cached = virtualCachePath(root, containerSha256, cacheId);
  const existing = await stat(cached).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) return { path: cached, size: existing.size };
  await mkdir(dirname(cached), { recursive: true });
  const temporary = `${cached}.${randomUUID()}.partial`;
  try {
    const written = await registry.materialize(format, filePath, entryId, temporary);
    await rename(temporary, cached);
    return { path: cached, size: written.size };
  } finally {
    await rm(temporary, { force: true });
  }
}
