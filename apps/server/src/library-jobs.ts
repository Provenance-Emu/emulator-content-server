import { setTimeout as pause } from 'node:timers/promises';
import type { CatalogDatabase, LibraryJobScope } from '@ecs/database';
import { DomainError } from '@ecs/domain';
import type { FastifyInstance } from 'fastify';
import { canSeeRoot } from './content.js';
import type { ServerContext } from './context.js';
import { requireOwner } from './http.js';
import { matchBody, type SourceMatchingService } from './source-matching.js';
import { scanRoot } from './source-scan.js';

interface ScanResult {
  rootId: string;
  medium: string;
  online: boolean;
  count: number;
}
const queues = new WeakMap<
  CatalogDatabase,
  {
    scan(root: { id: string; path: string }, actorId: string): Promise<ScanResult>;
    stop(): Promise<void>;
  }
>();
export async function enqueueRootScan(
  catalog: CatalogDatabase,
  root: { id: string; path: string },
  actorId: string,
): Promise<ScanResult> {
  const queue = queues.get(catalog);
  return queue ? queue.scan(root, actorId) : scanRoot(catalog, root, actorId);
}
export async function stopLibraryJobs(catalog: CatalogDatabase): Promise<void> {
  await queues.get(catalog)?.stop();
}

/** One server-owned disk/CPU worker. HTTP connections never own its lifetime. */
export function registerLibraryJobs(
  app: FastifyInstance,
  context: ServerContext,
  matching: SourceMatchingService,
): void {
  const repository = context.catalog.libraryJobs;
  repository.recover();
  let running: Promise<void> | null = null;
  let current: { id: string; abort: AbortController } | null = null;
  let closing = false;
  const waiters = new Map<string, Set<() => void>>();
  function notify(id: string): void {
    for (const resolve of waiters.get(id) ?? []) resolve();
    waiters.delete(id);
  }
  async function stop(): Promise<void> {
    closing = true;
    current?.abort.abort();
    await running;
    for (const id of waiters.keys()) notify(id);
    queues.delete(context.catalog);
  }
  queues.set(context.catalog, {
    stop,
    async scan(root, actorId) {
      const result = repository.create(
        'scan',
        { rootId: root.id },
        { online: false, checksum: false },
        actorId,
      );
      wake();
      while (!closing) {
        const job = repository.get(result.job.id);
        if (!job || ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state)) break;
        await new Promise<void>((resolve) => {
          const entries = waiters.get(result.job.id) ?? new Set();
          entries.add(resolve);
          waiters.set(result.job.id, entries);
        });
      }
      const saved = repository.scanResult(result.job.id, root.id);
      if (saved) return saved;
      throw new DomainError(
        'scan-interrupted',
        409,
        'The shared scan was cancelled or interrupted. Resume it from shared jobs.',
      );
    },
  });
  function wake(): void {
    if (closing || running) return;
    running = work().finally(() => {
      running = null;
      if (!closing && repository.list(100).some((job) => job.state === 'queued')) wake();
    });
  }
  async function work(): Promise<void> {
    while (!closing) {
      const next = repository.next();
      if (!next) return;
      const abort = new AbortController();
      current = { id: next.job.id, abort };
      try {
        const actor = context.catalog.actorForUser(next.actorId);
        if (actor?.kind !== 'user' || (next.job.kind === 'match' && !actor.isOwner))
          throw new DomainError('forbidden', 403, 'The job owner is unavailable.');
        if (next.job.kind === 'match' && next.job.options.refreshCatalogs) {
          if (!next.job.options.online)
            throw new DomainError(
              'catalog-offline',
              400,
              'Enable online providers to update hosted catalogs.',
            );
          await matching.prepareCatalogs?.(repository.matchingSystems(next.job.id), abort.signal);
        }
        while (!closing) {
          abort.signal.throwIfAborted();
          const entries = repository.pendingItems(next.job.id, 50);
          if (!entries.length) break;
          for (const entry of entries) {
            abort.signal.throwIfAborted();
            repository.current(next.job.id, entry.sourceId);
            try {
              if (next.job.kind === 'scan') {
                const root = context.catalog.getContentRoot(entry.sourceId);
                if (root && !canSeeRoot(actor, root.libraryId, context.catalog))
                  throw new DomainError(
                    'forbidden',
                    403,
                    'The job creator no longer has access to this folder',
                  );
                if (!root)
                  repository.finishItem(next.job.id, {
                    ...entry,
                    status: 'skipped',
                    error: 'Folder was removed.',
                  });
                else {
                  const result = await scanRoot(context.catalog, root, next.actorId, abort.signal);
                  repository.saveScanResult(next.job.id, root.id, result);
                  repository.finishItem(next.job.id, { ...entry, status: 'saved' });
                }
              } else {
                if (!context.catalog.getSource(entry.sourceId))
                  repository.finishItem(next.job.id, {
                    ...entry,
                    status: 'skipped',
                    error: 'Source was removed.',
                  });
                else
                  repository.finishItem(next.job.id, {
                    sourceId: entry.sourceId,
                    ...(await matching.autoMatch(
                      actor,
                      entry.sourceId,
                      next.job.options,
                      abort.signal,
                    )),
                  });
              }
            } catch (error) {
              if (abort.signal.aborted) throw error;
              if (error instanceof DomainError && error.code === 'root-busy') {
                await pause(100, undefined, { signal: abort.signal });
                continue;
              }
              repository.finishItem(next.job.id, {
                ...entry,
                status: 'failed',
                error:
                  error instanceof DomainError
                    ? error.message
                    : 'Matching could not finish this source.',
              });
            }
            // Yield between files so cancellation and other clients are serviced on fast disks.
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
        if (!closing && !abort.signal.aborted) repository.state(next.job.id, 'completed');
      } catch (error) {
        if (closing)
          repository.state(
            next.job.id,
            'interrupted',
            'Server stopped during this job. Resume to continue pending work.',
          );
        else if (abort.signal.aborted) repository.state(next.job.id, 'cancelled');
        else
          repository.state(
            next.job.id,
            'failed',
            error instanceof DomainError ? error.message : 'The shared job could not finish.',
          );
      } finally {
        current = null;
        notify(next.job.id);
      }
    }
  }
  app.addHook('onReady', async () => wake());
  app.addHook('preClose', stop);
  app.post('/api/v1/library-jobs', async (request, reply) => {
    const actor = requireOwner(request, 'Only the server owner can run shared library jobs');
    const body = request.body as Record<string, unknown> | null;
    if (
      !body ||
      Array.isArray(body) ||
      !['scan', 'match'].includes(String(body.kind)) ||
      Object.keys(body).some(
        (key) => !['kind', 'rootId', 'libraryId', 'unassigned', 'options'].includes(key),
      )
    )
      throw new DomainError('invalid-request', 400, 'Expected a job kind and library scope');
    const scope: LibraryJobScope = {};
    for (const key of ['rootId', 'libraryId'] as const)
      if (body[key] !== undefined) {
        if (typeof body[key] !== 'string' || body[key].length > 200 || !body[key])
          throw new DomainError('invalid-request', 400, 'Invalid job scope');
        scope[key] = body[key];
      }
    if (body.unassigned !== undefined && typeof body.unassigned !== 'boolean')
      throw new DomainError('invalid-request', 400, 'Invalid job scope');
    if (body.unassigned === true) scope.unassigned = true;
    if (scope.libraryId && scope.unassigned)
      throw new DomainError('invalid-request', 400, 'Choose one library scope');
    if (scope.rootId) {
      const root = context.catalog.getContentRoot(scope.rootId);
      if (
        !root ||
        (scope.libraryId && root.libraryId !== scope.libraryId) ||
        (scope.unassigned && root.libraryId !== null)
      )
        throw new DomainError('not-found', 404, 'Content root not found');
    }
    if (scope.libraryId && !context.catalog.getLibrary(scope.libraryId))
      throw new DomainError('not-found', 404, 'Library not found');
    const result = repository.create(
      body.kind as 'scan' | 'match',
      scope,
      matchBody(body.options ?? { checksum: true }),
      actor.userId,
    );
    reply.header('cache-control', 'private, no-store');
    reply.code(result.reused ? 200 : 202);
    wake();
    return result;
  });
  app.get('/api/v1/library-jobs', async (request, reply) => {
    requireOwner(request, 'Only the server owner can view shared library jobs');
    reply.header('cache-control', 'private, no-store');
    const query = request.query as { limit?: string; cursor?: string };
    const limit = pageLimit(query.limit);
    const jobs = repository.list(limit + 1, query.cursor);
    return {
      jobs: jobs.slice(0, limit),
      nextCursor: jobs.length > limit ? (jobs[limit - 1]?.id ?? null) : null,
    };
  });
  app.get('/api/v1/library-jobs/:jobId', async (request, reply) => {
    requireOwner(request, 'Only the server owner can view shared library jobs');
    reply.header('cache-control', 'private, no-store');
    return { job: getJob((request.params as { jobId: string }).jobId) };
  });
  app.get('/api/v1/library-jobs/:jobId/items', async (request, reply) => {
    requireOwner(request, 'Only the server owner can view shared library jobs');
    reply.header('cache-control', 'private, no-store');
    const id = (request.params as { jobId: string }).jobId;
    getJob(id);
    const query = request.query as { limit?: string; cursor?: string; status?: string };
    if (
      query.status &&
      !['pending', 'saved', 'review', 'unmatched', 'failed', 'skipped', 'reviewed'].includes(
        query.status,
      )
    )
      throw new DomainError('invalid-request', 400, 'Invalid job result status');
    const limit = pageLimit(query.limit);
    const items = repository.items(id, limit + 1, query.cursor, query.status);
    return {
      items: items.slice(0, limit).map((item) => {
        const source = context.catalog.getSource(item.sourceId);
        return {
          ...item,
          ...(source
            ? {
                source: {
                  id: source.id,
                  rootId: source.rootId,
                  libraryId: source.libraryId,
                  name: source.displayName,
                  ...(source.title ? { title: source.title } : {}),
                  ...(source.artworkAvailable ? { artworkAvailable: true } : {}),
                  kind: source.kind,
                  size: source.size,
                  systemId: source.systemId,
                  groupFileCount: source.groupMembers?.length ?? 0,
                  groupError: source.groupError ?? null,
                  availability: source.availability,
                  medium: context.catalog.contentRootMedium(source.rootId) ?? 'unknown',
                  contentPath: `/api/v1/sources/${source.id}/content`,
                },
              }
            : {}),
        };
      }),
      nextCursor: items.length > limit ? (items[limit - 1]?.sourceId ?? null) : null,
    };
  });
  app.post('/api/v1/library-jobs/:jobId/items/:sourceId/reviewed', async (request, reply) => {
    requireOwner(request, 'Only the server owner can review shared job results');
    reply.header('cache-control', 'private, no-store');
    const { jobId, sourceId } = request.params as { jobId: string; sourceId: string };
    getJob(jobId);
    repository.reviewed(jobId, sourceId);
    return { job: getJob(jobId) };
  });
  app.post('/api/v1/library-jobs/:jobId/cancel', async (request, reply) => {
    requireOwner(request, 'Only the server owner can cancel shared library jobs');
    reply.header('cache-control', 'private, no-store');
    const id = (request.params as { jobId: string }).jobId;
    const job = getJob(id);
    if (['completed', 'cancelled', 'failed'].includes(job.state)) return { job };
    if (current?.id === id) current.abort.abort();
    const cancelled = repository.state(id, 'cancelled');
    if (current?.id !== id) notify(id);
    return { job: cancelled };
  });
  app.post('/api/v1/library-jobs/:jobId/resume', async (request, reply) => {
    requireOwner(request, 'Only the server owner can resume shared library jobs');
    reply.header('cache-control', 'private, no-store');
    const id = (request.params as { jobId: string }).jobId;
    if (current?.id === id && current.abort.signal.aborted) {
      await new Promise<void>((resolve) => {
        const entries = waiters.get(id) ?? new Set();
        entries.add(resolve);
        waiters.set(id, entries);
      });
    }
    const body = request.body as { retry?: unknown } | null;
    if (body?.retry !== undefined && !['failed', 'unmatched'].includes(String(body.retry)))
      throw new DomainError('invalid-request', 400, 'Invalid retry status');
    const job = repository.resume(id, body?.retry as 'failed' | 'unmatched' | undefined);
    wake();
    return { job };
  });
  function getJob(id: string) {
    const job = repository.get(id);
    if (!job) throw new DomainError('not-found', 404, 'Shared job not found');
    return job;
  }
}
function pageLimit(value?: string): number {
  if (value === undefined) return 25;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 99)
    throw new DomainError('invalid-request', 400, 'Page size must be between 1 and 99');
  return limit;
}
