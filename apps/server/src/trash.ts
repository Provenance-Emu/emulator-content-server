import { rm } from 'node:fs/promises';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { TRASH_RETENTION_DAYS, type TrashEntryRecord, type TrashPosition } from '@ecs/database';
import { DomainError } from '@ecs/domain';
import { decodeCursor, encodeCursor } from '@ecs/protocol';
import { blobPath, locationOnline, removeStaging } from '@ecs/storage';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from './context.js';
import { assetDecision, itemDecision, requireUser } from './http.js';

/**
 * Keeps blob collection apart from upload completion.
 *
 * Completing an upload places bytes and then writes the rows that name them.
 * A collection between those two steps would remove bytes a new file row is
 * about to point at. Completions share the gate; a collection holds it alone.
 */
export class BlobGate {
  private sharing = 0;
  private alone = false;
  private waiting: Array<() => void> = [];

  async shared<T>(work: () => Promise<T>): Promise<T> {
    while (this.alone) await this.turn();
    this.sharing += 1;
    try {
      return await work();
    } finally {
      this.sharing -= 1;
      this.wake();
    }
  }

  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    while (this.alone || this.sharing > 0) await this.turn();
    this.alone = true;
    try {
      return await work();
    } finally {
      this.alone = false;
      this.wake();
    }
  }

  private turn(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) resolve();
  }
}

export function blobGate(context: ServerContext): BlobGate {
  context.blobGate ??= new BlobGate();
  return context.blobGate;
}

export interface RetentionResult {
  items: number;
  files: number;
  blobs: number;
}

const PURGE_BATCH = 200;
const BLOB_BATCH = 100;

/**
 * Removes what has been in the trash past its date, then the bytes nothing
 * names any more. Nothing here acts on a row before its `purge_after`.
 */
export async function runRetention(
  context: ServerContext,
  warn: (message: string) => void,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const { catalog } = context;
  const result: RetentionResult = { items: 0, files: 0, blobs: 0 };
  for (;;) {
    const purged = catalog.purgeExpired(now.toISOString(), PURGE_BATCH);
    result.items += purged.items;
    result.files += purged.files;
    for (const uploadId of purged.openUploads) {
      await removeStaging(context.dataDir, uploadId).catch(() => undefined);
    }
    if (purged.items + purged.files === 0) break;
    await yieldToRequests();
  }
  let after: string | null = null;
  for (;;) {
    const candidates = catalog.unreferencedBlobs(BLOB_BATCH, after);
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      after = candidate.sha256;
      if (await collectBlob(context, candidate, warn)) result.blobs += 1;
    }
  }
  return result;
}

async function collectBlob(
  context: ServerContext,
  candidate: { sha256: string; locationId: string | null },
  warn: (message: string) => void,
): Promise<boolean> {
  const { catalog } = context;
  const location = candidate.locationId ? catalog.getStorageLocation(candidate.locationId) : null;
  if (candidate.locationId && !location) return false;
  const root = location?.path ?? context.dataDir;
  return blobGate(context).exclusive(async () => {
    // An upload of the same bytes may have finished while this waited.
    if (catalog.blobReferenced(candidate.sha256)) return false;
    // An unplugged drive keeps its row, and the bytes are collected when it
    // returns. Checked here, right before removing, so a drive that drops out
    // is not mistaken for bytes that are already gone.
    if (location && !(await locationOnline(location.path))) return false;
    try {
      // The path is built from a digest the catalog holds, never from a request.
      await rm(blobPath(root, candidate.sha256));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        warn('A stored file could not be removed and will be retried');
        return false;
      }
    }
    return catalog.forgetBlob(candidate.sha256);
  });
}

/** Runs retention now and then hourly, one run at a time. */
export function scheduleRetention(
  context: ServerContext,
  warn: (message: string) => void,
): { run: (now?: Date) => Promise<RetentionResult>; stop: () => Promise<void> } {
  let running: Promise<RetentionResult> | null = null;
  const run = (now?: Date): Promise<RetentionResult> => {
    if (running) return running.then(() => run(now));
    const started = runRetention(context, warn, now).finally(() => {
      if (running === started) running = null;
    });
    running = started;
    return started;
  };
  const background = () => {
    void run().catch(() => warn('Trash retention deferred'));
  };
  const timer = setInterval(background, 3_600_000);
  timer.unref();
  return {
    run,
    async stop() {
      clearInterval(timer);
      await running?.catch(() => undefined);
    },
  };
}

function query(request: FastifyRequest, key: string): string | undefined {
  const value = (request.query as Record<string, unknown> | undefined)?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new DomainError('invalid-body', 400, `Invalid ${key}`);
  return value;
}

function position(cursor: string | undefined): TrashPosition | null {
  if (!cursor) return null;
  const decoded = decodeCursor(cursor);
  const split = decoded?.indexOf('|') ?? -1;
  if (!decoded || split < 1 || split === decoded.length - 1) {
    throw new DomainError('invalid-body', 400, 'cursor is invalid');
  }
  return { deletedAt: decoded.slice(0, split), id: decoded.slice(split + 1) };
}

export function registerTrashRoutes(app: FastifyInstance, context: ServerContext): void {
  const { catalog } = context;

  /** The same decision a restore makes, so the list never shows what the caller cannot restore. */
  const restorable = (actor: ReturnType<typeof requireUser>, entry: TrashEntryRecord): boolean => {
    try {
      const item = catalog.getItem(entry.itemId);
      if (!item) return false;
      if (entry.kind === 'item') {
        itemDecision(catalog, actor, item, 'write');
        return true;
      }
      const asset = catalog.assetIncludingDeleted(entry.id);
      if (!asset) return false;
      assetDecision(catalog, actor, item, asset, 'write');
      return true;
    } catch {
      return false;
    }
  };

  app.get('/api/v1/trash', async (request) => {
    const actor = requireUser(request, 'write');
    const libraryId = query(request, 'libraryId') ?? null;
    const raw = query(request, 'limit');
    const limit = raw === undefined ? 50 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError('invalid-body', 400, 'limit must be 1-100');
    }
    let after = position(query(request, 'cursor'));
    const entries: TrashEntryRecord[] = [];
    let more = true;
    // Entries the caller may not restore are skipped, so a page can take
    // several reads. The bound keeps one request from walking a whole trash.
    for (let reads = 0; reads < 20 && more && entries.length < limit; reads += 1) {
      const page = catalog.listTrash({ libraryId, after, limit });
      more = page.next !== null;
      for (const entry of page.entries) {
        after = { deletedAt: entry.deletedAt, id: entry.id };
        if (restorable(actor, entry)) entries.push(entry);
        if (entries.length === limit) {
          more = more || entry !== page.entries.at(-1);
          break;
        }
      }
    }
    return {
      entries: entries.map((entry) => ({
        kind: entry.kind,
        id: entry.id,
        name: entry.name,
        libraryId: entry.libraryId,
        itemId: entry.itemId,
        itemTitle: entry.itemTitle,
        systemIdentifier: entry.systemIdentifier,
        size: entry.size,
        fileCount: entry.fileCount,
        deletedAt: entry.deletedAt,
        ...(entry.deletedBy
          ? {
              deletedBy: {
                id: entry.deletedBy,
                ...(entry.deletedByName ? { name: entry.deletedByName } : {}),
              },
            }
          : {}),
        purgeAfter: entry.purgeAfter,
        itemDeleted: entry.itemDeleted,
      })),
      nextCursor: more && after ? encodeCursor(`${after.deletedAt}|${after.id}`) : null,
    };
  });

  app.post('/api/v1/items/:itemId/restore', async (request) => {
    const actor = requireUser(request, 'write');
    const item = catalog.getItem((request.params as { itemId: string }).itemId);
    if (!item) throw new DomainError('not-found', 404, 'Item not found');
    itemDecision(catalog, actor, item, 'write');
    return catalog.restoreItem(item.id, actor.userId, actor.deviceId);
  });

  app.post('/api/v1/files/:assetId/restore', async (request) => {
    const actor = requireUser(request, 'write');
    const asset = catalog.assetIncludingDeleted((request.params as { assetId: string }).assetId);
    if (!asset) throw new DomainError('not-found', 404, 'File not found');
    const item = catalog.getItem(asset.itemId);
    if (!item) throw new DomainError('not-found', 404, 'File not found');
    assetDecision(catalog, actor, item, asset, 'write');
    return catalog.restoreAsset(asset.id, actor.userId, actor.deviceId);
  });
}

export { TRASH_RETENTION_DAYS };
