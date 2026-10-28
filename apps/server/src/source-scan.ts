import { lstat, realpath } from 'node:fs/promises';
import type { CatalogDatabase, SourceInspection } from '@ecs/database';
import { DomainError } from '@ecs/domain';
import { inspectRoot, probeRoot, resolveInside } from '@ecs/storage';
import { reserveContentRoots } from './root-mutations.js';

/** A scan and all of its absence proofs share the organizer's root reservations. */
export async function scanRoot(
  catalog: CatalogDatabase,
  root: { id: string; path: string },
  actorId: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const registered = catalog.getContentRoot(root.id);
  if (!registered) throw new DomainError('not-found', 404, 'Content root not found');
  const roots = catalog
    .listContentRoots()
    .filter((candidate) => candidate.libraryId === registered.libraryId);
  const releaseRoots = reserveContentRoots(
    catalog,
    roots.map((candidate) => candidate.id),
  );
  try {
    catalog.beginRootScan(root.id);
    try {
      const inspected = await inspectRoot(registered.path, {
        pinnedRoot: true,
        ...(signal ? { signal } : {}),
      });
      if (inspected.online)
        inspected.files = await pruneRenamedEntries(registered.path, inspected.files);
      const verifiedMoveSourceIds = inspected.online
        ? await verifiedMoves(catalog, registered.id, registered.path, inspected.files)
        : [];
      // Check again after traversal and move verification, before committing any
      // observations. A replaced/missing root must leave the last good index intact.
      if (inspected.online && (await realpath(registered.path)) !== registered.path)
        throw new DomainError('invalid-body', 400, 'Registered folder has changed');
      signal?.throwIfAborted();
      const count = catalog.applyInspection({
        rootId: root.id,
        actorId,
        online: inspected.online,
        files: inspected.files,
        verifiedMoveSourceIds,
      });
      catalog.recordRootCheck({
        rootId: root.id,
        availability: inspected.online ? 'online' : 'offline',
        medium: inspected.medium,
      });
      catalog.finishRootScan({ rootId: root.id, succeeded: true });
      return { rootId: root.id, medium: inspected.medium, online: inspected.online, count };
    } catch (error) {
      catalog.finishRootScan({ rootId: root.id, succeeded: false });
      throw error;
    }
  } finally {
    releaseRoots();
  }
}

/** A traversal can observe a rename twice: old name first, new directory later.
 * Recheck duplicate identities before committing so stale names cannot manufacture
 * ambiguity and permanently detach saved matches. Real hard links remain ambiguous. */
async function pruneRenamedEntries<T extends SourceInspection>(
  rootPath: string,
  files: T[],
): Promise<T[]> {
  const counts = new Map<string, number>();
  for (const file of files)
    if (file.filesystemIdentity)
      counts.set(file.filesystemIdentity, (counts.get(file.filesystemIdentity) ?? 0) + 1);
  const current: T[] = [];
  for (const file of files) {
    if (!file.filesystemIdentity || counts.get(file.filesystemIdentity) === 1) {
      current.push(file);
      continue;
    }
    try {
      const path = await resolveInside(rootPath, file.relativePath, { pinnedRoot: true });
      const facts = await lstat(path, { bigint: true });
      if (
        facts.isFile() &&
        `${facts.dev}:${facts.ino}:${facts.birthtimeNs}` === file.filesystemIdentity &&
        Number(facts.size) === file.size &&
        Number(facts.mtimeNs) / 1e6 === file.mtimeMs
      )
        current.push(file);
    } catch (error) {
      // Permission/containment errors are not proof a competing name disappeared.
      // Abort this snapshot rather than transferring a record on incomplete facts.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return current;
}

async function verifiedMoves(
  catalog: CatalogDatabase,
  rootId: string,
  rootPath: string,
  files: SourceInspection[],
): Promise<string[]> {
  const candidates = catalog.inspectionMoveCandidates(rootId);
  const byIdentity = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    if (!candidate.filesystemIdentity) continue;
    const entries = byIdentity.get(candidate.filesystemIdentity) ?? [];
    entries.push(candidate);
    byIdentity.set(candidate.filesystemIdentity, entries);
  }
  const fileCounts = new Map<string, number>();
  for (const file of files)
    if (file.filesystemIdentity)
      fileCounts.set(file.filesystemIdentity, (fileCounts.get(file.filesystemIdentity) ?? 0) + 1);
  const verified: string[] = [];
  const online = new Map<string, boolean>();
  for (const file of files) {
    if (!file.filesystemIdentity || file.mtimeMs == null) continue;
    const matching = byIdentity.get(file.filesystemIdentity);
    if (matching?.length !== 1 || fileCounts.get(file.filesystemIdentity) !== 1) continue;
    const candidate = matching[0];
    if (!candidate) continue;
    if (
      candidate.rootId === rootId ||
      candidate.size !== file.size ||
      candidate.mtimeMs !== file.mtimeMs
    )
      continue;
    const oldRoot = catalog.getContentRoot(candidate.rootId);
    if (!oldRoot) continue;
    try {
      let oldOnline = online.get(oldRoot.id);
      if (oldOnline === undefined) {
        oldOnline = (await probeRoot(oldRoot.path)).online;
        online.set(oldRoot.id, oldOnline);
      }
      if (!oldOnline) continue;
      // Resolve containment before lstat, so an escaped or replaced root cannot prove absence.
      const oldPath = await resolveInside(oldRoot.path, candidate.relativePath, {
        pinnedRoot: true,
      });
      try {
        await lstat(oldPath);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
      if (!(await probeRoot(oldRoot.path)).online) continue;
      // Recheck the destination without opening bytes. Multiple hard links are ambiguous
      // even when the other names live outside registered roots.
      const targetPath = await resolveInside(rootPath, file.relativePath, { pinnedRoot: true });
      const target = await lstat(targetPath, { bigint: true });
      if (
        !target.isFile() ||
        target.nlink !== 1n ||
        `${target.dev}:${target.ino}:${target.birthtimeNs}` !== file.filesystemIdentity ||
        Number(target.size) !== file.size ||
        Number(target.mtimeNs) / 1e6 !== file.mtimeMs
      )
        continue;
      verified.push(candidate.id);
    } catch {
      /* Permission errors, symlink changes, and unavailable roots are not evidence of a move. */
    }
  }
  return verified;
}
