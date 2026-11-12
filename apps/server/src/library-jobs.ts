import { setTimeout as pause } from 'node:timers/promises';
import {
  type CatalogDatabase,
  type LibraryJobRecord,
  type LibraryJobScope,
  PROVIDERS_FAILED_REASON,
} from '@ecs/database';
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
interface ScanOutcome {
  failure?: 'conflict' | 'failed';
}
const queues = new WeakMap<
  CatalogDatabase,
  {
    scan(root: { id: string; path: string }, actorId: string): Promise<ScanResult>;
    scanningLibrary(libraryId: string | null): boolean;
    stop(): Promise<void>;
    checkDetails(rootId: string, sourceId: string): void;
    index(rootId: string, actorId: string): void;
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
export function rootScanInProgress(catalog: CatalogDatabase, libraryId: string | null): boolean {
  return queues.get(catalog)?.scanningLibrary(libraryId) ?? false;
}

export function checkSourceDetails(
  catalog: CatalogDatabase,
  rootId: string,
  sourceId: string,
): void {
  queues.get(catalog)?.checkDetails(rootId, sourceId);
}
export function indexNewRoot(catalog: CatalogDatabase, rootId: string, actorId: string): void {
  queues.get(catalog)?.index(rootId, actorId);
}

const automaticBatch = 50;
const idleCheckInterval = 5 * 60_000;
const normalRetry = 48 * 60 * 60_000;
const failedRetry = 60 * 60_000;
const automaticOptions = { online: true, checksum: true, allowExactNames: true };

/** One server-owned disk/CPU worker. HTTP connections never own its lifetime. */
export function registerLibraryJobs(
  app: FastifyInstance,
  context: ServerContext,
  matching: Pick<SourceMatchingService, 'autoMatch' | 'prepareCatalogs'>,
  activation?: Promise<void>,
): void {
  const repository = context.catalog.libraryJobs;
  let started = false;
  let running: Promise<void> | null = null;
  let current: { id: string; abort: AbortController; scanLibrary?: string | null } | null = null;
  let closing = false;
  let halted = false;
  const interruption =
    'Library work paused because server storage could not be written. Check free disk space and storage access, then resume remaining work.';
  function halt(): void {
    halted = true;
    // Do not log provider errors, paths, or credentials from an arbitrary cause.
    app.log.warn('Library worker paused after a storage or queue failure. Resume after recovery.');
    for (const id of waiters.keys()) notify(id);
  }
  function visible(job: LibraryJobRecord): LibraryJobRecord {
    // Even the interruption write can fail on a full disk. Keep that failure
    // visible to every session until it can be persisted or the server restarts.
    return halted && ['running', 'queued'].includes(job.state)
      ? { ...job, state: 'interrupted', currentSourceId: null, error: interruption }
      : job;
  }
  function requireWritableWorker(): void {
    if (halted) throw new DomainError('library-storage-unavailable', 503, interruption);
  }
  function recoverQueue<T>(operation: () => T): T {
    const recovering = halted;
    try {
      if (recovering) repository.recover();
      const result = operation();
      halted = false;
      return result;
    } catch (error) {
      if (recovering && !(error instanceof DomainError))
        throw new DomainError('library-storage-unavailable', 503, interruption);
      throw error;
    }
  }
  const waiters = new Map<string, Set<() => void>>();
  const scanOutcomes = new Map<string, Map<string, ScanOutcome>>();
  function scanOutcome(id: string, rootId: string): ScanOutcome {
    let roots = scanOutcomes.get(id);
    if (!roots) {
      roots = new Map();
      scanOutcomes.set(id, roots);
    }
    let outcome = roots.get(rootId);
    if (!outcome) {
      outcome = {};
      roots.set(rootId, outcome);
    }
    return outcome;
  }
  function notify(id: string): void {
    for (const resolve of waiters.get(id) ?? []) resolve();
    waiters.delete(id);
    scanOutcomes.delete(id);
  }
  const pendingDetails = new Map<string, { actorId: string; afterPath?: string }>();
  const idleChecks = new Set<string>();
  let idleTimer: NodeJS.Timeout | undefined;
  // What the automatic fill last decided for a folder, so the interface can say it instead of staying silent.
  const automatic = new Map<
    string,
    { state: 'queued' | 'unchanged'; checkedAt: string; jobId?: string }
  >();
  const decided = (
    rootId: string,
    state: 'queued' | 'unchanged',
    jobId = automatic.get(rootId)?.jobId,
  ) =>
    automatic.set(rootId, {
      state,
      checkedAt: new Date().toISOString(),
      ...(jobId ? { jobId } : {}),
    });
  function ownerId() {
    return context.catalog.listUsers().find((user) => user.isOwner)?.id;
  }
  function fillMissingDetails() {
    if (closing || !context.automaticMatching) return;
    for (const [rootId, { actorId, afterPath }] of pendingDetails) {
      pendingDetails.delete(rootId);
      const retryDue = idleChecks.delete(rootId);
      const actor = context.catalog.actorForUser(actorId);
      if (!context.catalog.getContentRoot(rootId) || actor?.kind !== 'user' || !actor.isOwner) {
        automatic.delete(rootId);
        continue;
      }
      const changed = repository.automaticCandidates(rootId, automaticBatch, 0, afterPath);
      const candidates =
        !changed.length && retryDue
          ? repository.automaticCandidates(rootId, automaticBatch, Date.now())
          : changed;
      if (!candidates.length) {
        decided(rootId, 'unchanged');
        continue;
      }
      try {
        const result = repository.create(
          'match',
          { rootId },
          automaticOptions,
          actorId,
          candidates.map(({ id }) => id),
        );
        decided(rootId, 'queued', result.job.id);
        if (changed.length === automaticBatch || (changed.length && retryDue)) {
          pendingDetails.set(rootId, { actorId, afterPath: changed.at(-1)?.relativePath });
          if (retryDue) idleChecks.add(rootId);
        }
        return;
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'library-job-conflict') throw error;
      }
    }
  }
  function scheduleIdleChecks() {
    const owner = ownerId();
    if (!owner) return;
    for (const root of context.catalog.listContentRoots()) {
      pendingDetails.set(root.id, { actorId: owner });
      idleChecks.add(root.id);
    }
    wake();
  }
  async function stop(): Promise<void> {
    closing = true;
    clearInterval(idleTimer);
    current?.abort.abort();
    await running;
    for (const id of waiters.keys()) notify(id);
    queues.delete(context.catalog);
  }
  queues.set(context.catalog, {
    stop,
    scanningLibrary: (libraryId) => current?.scanLibrary === libraryId,
    checkDetails(rootId, sourceId) {
      if (closing || !context.automaticMatching) return;
      try {
        const owner = ownerId();
        if (!owner) return;
        if (!repository.automaticCandidates(rootId, 1, 0, '', sourceId).length) return;
        pendingDetails.set(rootId, { actorId: owner });
        if (!halted) {
          const { job } = repository.create('match', { rootId }, automaticOptions, owner, [
            sourceId,
          ]);
          decided(rootId, 'queued', job.id);
        }
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'library-job-conflict') halt();
      }
      wake();
    },
    index(rootId, actorId) {
      if (closing || halted || !context.automaticMatching) return;
      try {
        repository.create('scan', { rootId }, { online: false, checksum: false }, actorId);
        wake();
      } catch {
        app.log.warn('Could not queue the initial folder check');
      }
    },
    async scan(root, actorId) {
      requireWritableWorker();
      const result = repository.create(
        'scan',
        { rootId: root.id },
        { online: false, checksum: false },
        actorId,
      );
      if (result.job.state === 'interrupted') repository.resume(result.job.id);
      // Retain the typed outcome for every caller sharing this job, even after
      // notification releases the queue's transient bookkeeping.
      const outcome = scanOutcome(result.job.id, root.id);
      wake();
      while (!closing) {
        const job = getJob(result.job.id);
        if (!job || ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state)) break;
        await new Promise<void>((resolve) => {
          const entries = waiters.get(result.job.id) ?? new Set();
          entries.add(resolve);
          waiters.set(result.job.id, entries);
        });
      }
      const saved = repository.scanResult(result.job.id, root.id);
      if (saved) return saved;
      if (outcome.failure === 'conflict')
        throw new DomainError(
          'conflict',
          409,
          'A scan is already pending or conflicts with another operation.',
        );
      if (outcome.failure === 'failed')
        throw new DomainError('scan-failed', 500, 'Scan failed. Retry scan.');
      throw new DomainError(
        'scan-interrupted',
        409,
        'The shared scan was cancelled or interrupted. Resume it from shared jobs.',
      );
    },
  });
  function wake(): void {
    if (!started || closing || halted || running) return;
    running = work()
      .catch(() => halt())
      .finally(() => {
        running = null;
        if (closing || halted) return;
        try {
          if (repository.list(100).some((job) => job.state === 'queued')) wake();
        } catch {
          halt();
        }
      });
  }
  async function work(): Promise<void> {
    while (!closing) {
      let next = repository.next();
      if (!next) {
        fillMissingDetails();
        next = repository.next();
      }
      if (!next) return;
      if (next.targeted && next.job.scope.rootId)
        decided(next.job.scope.rootId, 'queued', next.job.id);
      const abort = new AbortController();
      current = { id: next.job.id, abort };
      let yielded = false;
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
            if (next.targeted && repository.foregroundQueued()) {
              yielded = true;
              break;
            }
            repository.current(next.job.id, entry.sourceId);
            const options = next.job.options;
            const evidence =
              context.automaticMatching &&
              next.job.kind === 'match' &&
              options.online &&
              options.checksum &&
              options.allowExactNames &&
              !options.providerIds &&
              !options.managerId
                ? repository.automaticMatchEvidence(entry.sourceId)
                : undefined;
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
                  const runningScan = current;
                  runningScan.scanLibrary = root.libraryId;
                  const result = await scanRoot(
                    context.catalog,
                    root,
                    next.actorId,
                    abort.signal,
                  ).finally(() => {
                    runningScan.scanLibrary = undefined;
                  });
                  repository.saveScanResult(next.job.id, root.id, result);
                  repository.finishItem(next.job.id, { ...entry, status: 'saved' });
                  if (context.automaticMatching && result.online) {
                    const owner = actor.isOwner ? actor.userId : ownerId();
                    if (owner) pendingDetails.set(root.id, { actorId: owner });
                  }
                }
              } else {
                if (!context.catalog.getSource(entry.sourceId))
                  repository.finishItem(next.job.id, {
                    ...entry,
                    status: 'skipped',
                    error: 'Source was removed.',
                  });
                else {
                  const outcome = await matching.autoMatch(
                    actor,
                    entry.sourceId,
                    options,
                    abort.signal,
                  );
                  if (evidence)
                    repository.recordAutomaticMatch(
                      entry.sourceId,
                      evidence,
                      Date.now() +
                        (outcome.error === PROVIDERS_FAILED_REASON ? failedRetry : normalRetry),
                    );
                  repository.finishItem(next.job.id, { sourceId: entry.sourceId, ...outcome });
                }
              }
            } catch (error) {
              if (abort.signal.aborted) throw error;
              // A storage outage is queue-wide, not a failed ROM. Leave the
              // current item pending and do not hammer the remaining library.
              if (storageUnavailable(error)) throw error;
              if (evidence)
                repository.recordAutomaticMatch(entry.sourceId, evidence, Date.now() + failedRetry);
              if (error instanceof DomainError && error.code === 'root-busy') {
                await pause(100, undefined, { signal: abort.signal });
                continue;
              }
              if (next.job.kind === 'scan')
                scanOutcome(next.job.id, entry.sourceId).failure =
                  error instanceof DomainError && error.status === 409 ? 'conflict' : 'failed';
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
          if (yielded) break;
        }
        if (!closing && !abort.signal.aborted)
          repository.state(next.job.id, yielded ? 'queued' : 'completed');
      } catch (error) {
        if (storageUnavailable(error)) halt();
        try {
          if (halted) repository.state(next.job.id, 'interrupted', interruption);
          else if (closing)
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
        } catch {
          halt();
        }
      } finally {
        current = null;
        notify(next.job.id);
      }
      if (halted) return;
    }
  }
  function start() {
    if (closing) return;
    repository.recover();
    started = true;
    if (context.automaticMatching) {
      scheduleIdleChecks();
      idleTimer = setInterval(() => {
        if (closing || running || halted) return;
        try {
          scheduleIdleChecks();
        } catch {
          halt();
        }
      }, idleCheckInterval);
      idleTimer.unref();
    }
    wake();
  }
  app.addHook('onReady', async () => {
    if (activation) {
      void activation.then(start).catch(() => {
        if (!closing) halt();
      });
    } else start();
  });
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
    const result = recoverQueue(() =>
      repository.create(
        body.kind as 'scan' | 'match',
        scope,
        matchBody(body.options ?? { online: true, checksum: true, allowExactNames: true }),
        actor.userId,
      ),
    );
    if (result.job.kind === 'scan' && result.job.state === 'interrupted')
      result.job = repository.resume(result.job.id);
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
      jobs: jobs.slice(0, limit).map(visible),
      nextCursor: jobs.length > limit ? (jobs[limit - 1]?.id ?? null) : null,
    };
  });
  app.get('/api/v1/library-jobs/overview', async (request, reply) => {
    requireOwner(request, 'Only the server owner can view library status');
    reply.header('cache-control', 'private, no-store');
    return {
      automaticMatching: context.automaticMatching === true,
      folders: context.catalog.listContentRoots().map((root) => {
        const last = automatic.get(root.id);
        const stoppedJobId = repository.stoppedMatch(root.id, root.libraryId);
        const jobId = last?.jobId ?? stoppedJobId;
        const job = jobId ? repository.get(jobId) : null;
        const details = job
          ? {
              jobState: visible(job).state,
              processed: job.processed,
              total: job.total,
              review: job.review,
              unmatched: job.unmatched,
              failed: job.failed,
              providerFailures: job.providerFailures ?? 0,
            }
          : {};
        return {
          rootId: root.id,
          label: root.label,
          libraryId: root.libraryId,
          ...repository.coverage(root.id),
          automatic: {
            ...(last ?? {}),
            state:
              pendingDetails.has(root.id) && job?.state !== 'running'
                ? 'waiting'
                : (last?.state ?? 'none'),
            ...(jobId ? { jobId } : {}),
            ...(stoppedJobId ? { stoppedJobId } : {}),
            ...details,
          },
        };
      }),
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
    const cancelled = recoverQueue(() => repository.state(id, 'cancelled'));
    if (current?.id !== id) notify(id);
    wake();
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
    // No worker is active while halted. Persist any status we could not write
    // during the outage before reclaiming work; failed recovery stays paused.
    const job = recoverQueue(() =>
      repository.resume(id, body?.retry as 'failed' | 'unmatched' | undefined),
    );
    wake();
    return { job };
  });
  function getJob(id: string) {
    const job = repository.get(id);
    if (!job) throw new DomainError('not-found', 404, 'Shared job not found');
    return visible(job);
  }
}
function storageUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  // SQLite primary codes: READONLY, IOERR, FULL, CANTOPEN (including extensions).
  return (
    code === 'ENOSPC' ||
    code === 'EDQUOT' ||
    (typeof errcode === 'number' && [8, 10, 13, 14].includes(errcode & 0xff))
  );
}
function pageLimit(value?: string): number {
  if (value === undefined) return 25;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 99)
    throw new DomainError('invalid-request', 400, 'Page size must be between 1 and 99');
  return limit;
}
