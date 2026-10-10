import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DomainError } from '@ecs/domain';
import { blobPath, virtualCachePath } from './paths.js';
import type { VirtualProviderRegistry } from './virtual.js';

export interface VirtualEntryBytes {
  format: string;
  path: string;
  offset: number;
  size: number;
}

export async function openVirtualEntry(
  root: string,
  containerSha256: string,
  registry: VirtualProviderRegistry,
  entryId: string,
): Promise<VirtualEntryBytes | null> {
  const container = blobPath(root, containerSha256);
  const located = await registry.locate(container, entryId);
  if (!located) return null;
  const { format } = located;
  const size = located.entry.uncompressedSize;
  if (located.sourceOffset !== null) {
    return { format, path: container, offset: located.sourceOffset, size };
  }
  const cached = virtualCachePath(root, containerSha256, entryId);
  const existing = await stat(cached).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) {
    if (existing.size !== size) {
      throw new DomainError('corrupt-blob', 500, 'Cached archive entry has the wrong size');
    }
    return { format, path: cached, offset: 0, size };
  }
  await mkdir(dirname(cached), { recursive: true });
  const temporary = `${cached}.${randomUUID()}.partial`;
  try {
    const expanded = await registry.materialize(format, container, entryId, temporary);
    await rename(temporary, cached);
    return { format, path: cached, offset: 0, size: expanded.size };
  } finally {
    await rm(temporary, { force: true });
  }
}
