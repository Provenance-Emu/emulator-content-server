import { type ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ProviderCapability } from './manifest.js';
import { PROVIDER_CAPABILITIES } from './manifest.js';
import type { MatchingInput, MatchingResult } from './matching.js';
import { validateCandidates } from './matching.js';
export interface MatchingJob {
  operation: 'list' | 'match' | 'artwork' | 'cheats';
  artworkUrl?: string;
  catalogCacheDirectory?: string;
  directory?: string;
  managerId?: string;
  providerIds?: string[];
  input?: MatchingInput;
}
export interface MatchingPluginDescription {
  id: string;
  name: string;
  kind: 'provider' | 'manager';
  capabilities: ProviderCapability[];
  network: boolean;
}
export interface MatchingReply {
  plugins: MatchingPluginDescription[];
  result?: MatchingResult;
  artwork?: string;
  file?: string;
}

export type MatchingWorkerScope = Pick<MatchingJob, 'directory' | 'catalogCacheDirectory'>;
const MAX_WORKERS = 2;
const MAX_QUEUED_JOBS = 64;
const MAX_WORKER_JOBS = 2048;
const MAX_WORKER_AGE_MS = 5 * 60_000;
const IDLE_MS = 5000;
interface PendingJob {
  id: string;
  key: string;
  job: MatchingJob;
  signal?: AbortSignal;
  abort: () => void;
  timer: NodeJS.Timeout;
  settled: boolean;
  worker?: Worker;
  resolve: (reply: MatchingReply) => void;
  reject: (error: Error) => void;
}
interface Worker {
  key: string;
  child: ChildProcess;
  current?: PendingJob;
  idle?: NodeJS.Timeout;
  created: number;
  completed: number;
  retired: boolean;
  exited: Promise<void>;
}
const queue: PendingJob[] = [];
const workers = new Set<Worker>();
const closingScopes = new Map<string, number>();
let closingAll = 0;
let draining = false;
function scopeKey(scope: MatchingWorkerScope): string {
  return JSON.stringify([scope.directory ?? null, scope.catalogCacheDirectory ?? null]);
}
function retire(worker: Worker): void {
  if (worker.retired) return;
  worker.retired = true;
  clearTimeout(worker.idle);
  worker.child.ref();
  worker.child.channel?.ref();
  worker.child.kill('SIGKILL');
}
function finish(request: PendingJob, error?: Error, reply?: MatchingReply, recycle = false): void {
  if (request.settled) return;
  request.settled = true;
  clearTimeout(request.timer);
  request.signal?.removeEventListener('abort', request.abort);
  const index = queue.indexOf(request);
  if (index >= 0) queue.splice(index, 1);
  const worker = request.worker;
  if (worker?.current === request) {
    worker.current = undefined;
    worker.completed++;
    if (
      error ||
      recycle ||
      worker.completed >= MAX_WORKER_JOBS ||
      performance.now() - worker.created >= MAX_WORKER_AGE_MS
    )
      retire(worker);
    else {
      worker.idle = setTimeout(() => {
        retire(worker);
        drain();
      }, IDLE_MS);
      worker.idle.unref();
      worker.child.unref();
      worker.child.channel?.unref();
    }
  }
  if (error) request.reject(error);
  else if (reply) request.resolve(reply);
  else request.reject(new Error('Matching host returned no data'));
  drain();
}
function spawnWorker(key: string): Worker {
  const child = fork(fileURLToPath(new URL('./matching-worker.js', import.meta.url)), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    // Keep credentials and Node injection options out of operator-installed code.
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), LANG: 'en_US.UTF-8' },
    execArgv: ['--max-old-space-size=192'],
  });
  let resolveExit = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const worker: Worker = {
    key,
    child,
    created: performance.now(),
    completed: 0,
    retired: false,
    exited,
  };
  workers.add(worker);
  const stopped = () => {
    if (!workers.delete(worker)) return;
    worker.retired = true;
    clearTimeout(worker.idle);
    if (worker.current) finish(worker.current, new Error('Matching host stopped'), undefined, true);
    resolveExit();
    drain();
  };
  child.once('exit', stopped);
  child.once('close', stopped); // Failed spawn can close without an exit event.
  child.once('error', () => {
    if (worker.current)
      finish(worker.current, new Error('Matching host unavailable'), undefined, true);
    else retire(worker);
  });
  child.once('disconnect', () => {
    if (worker.current) finish(worker.current, new Error('Matching host stopped'), undefined, true);
    else retire(worker);
  });
  child.on('message', (raw: unknown) => {
    if (worker.retired) return;
    const request = worker.current;
    try {
      if (!request || !raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Unsolicited response');
      const envelope = raw as { id?: unknown; reply?: unknown; recycle?: unknown };
      if (
        Object.keys(raw).length !== 3 ||
        envelope.id !== request.id ||
        typeof envelope.recycle !== 'boolean'
      )
        throw new Error('Invalid envelope');
      finish(request, undefined, validateReply(envelope.reply, request.job), envelope.recycle);
    } catch {
      if (request)
        finish(request, new Error('Matching host returned invalid data'), undefined, true);
      else retire(worker);
    }
  });
  return worker;
}
function drain(): void {
  if (draining || closingAll) return;
  draining = true;
  try {
    for (let index = 0; index < queue.length; ) {
      const request = queue[index];
      if (!request) break;
      if (closingScopes.has(request.key)) {
        index++;
        continue;
      }
      let worker = [...workers].find((w) => !w.retired && w.key === request.key);
      if (worker?.current) {
        index++;
        continue;
      }
      if (!worker) {
        if (workers.size >= MAX_WORKERS) {
          const idle = [...workers].find((w) => !w.retired && !w.current);
          if (idle) retire(idle);
          index++;
          continue;
        }
        try {
          worker = spawnWorker(request.key);
        } catch {
          finish(request, new Error('Matching host unavailable'));
          continue;
        }
      }
      queue.splice(index, 1);
      clearTimeout(worker.idle);
      worker.current = request;
      request.worker = worker;
      worker.child.ref();
      worker.child.channel?.ref();
      worker.child.send({ id: request.id, job: request.job }, (error) => {
        if (error) finish(request, new Error('Matching host unavailable'), undefined, true);
      });
    }
  } finally {
    draining = false;
  }
}
/** Bounded reusable process isolation for trusted operator executables, not an OS sandbox. */
export async function matchingJob(
  job: MatchingJob,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<MatchingReply> {
  options.signal?.throwIfAborted();
  const serialized = JSON.stringify(job);
  if (Buffer.byteLength(serialized) > 512 * 1024) throw new Error('Matching input too large');
  // Snapshot queued input so callers cannot change its validation or worker scope later.
  const snapshot = JSON.parse(serialized) as MatchingJob;
  const key = scopeKey(snapshot);
  if (closingAll || closingScopes.has(key)) throw new Error('Matching workers closing');
  if (queue.length >= MAX_QUEUED_JOBS) throw new Error('Matching queue full');
  const timeoutMs = options.timeoutMs ?? 25_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000)
    throw new RangeError('Invalid matching deadline');
  return new Promise((resolve, reject) => {
    const request: PendingJob = {
      id: randomUUID(),
      key,
      job: snapshot,
      signal: options.signal,
      settled: false,
      resolve,
      reject,
      abort: () => finish(request, new Error('Matching cancelled'), undefined, true),
      timer: setTimeout(
        () => finish(request, new Error('Matching timed out'), undefined, true),
        timeoutMs,
      ),
    };
    queue.push(request);
    options.signal?.addEventListener('abort', request.abort, { once: true });
    if (options.signal?.aborted) request.abort();
    else drain();
  });
}
/** Await actual child exits; scoped closure does not stop another server's workers. */
export async function closeMatchingWorkers(scope?: MatchingWorkerScope): Promise<void> {
  const key = scope ? scopeKey(scope) : undefined;
  if (key === undefined) closingAll++;
  else closingScopes.set(key, (closingScopes.get(key) ?? 0) + 1);
  const closing = [...workers].filter((w) => key === undefined || w.key === key);
  try {
    for (const request of [...queue])
      if (key === undefined || request.key === key)
        finish(request, new Error('Matching workers closing'), undefined, true);
    for (const worker of closing) {
      if (worker.current)
        finish(worker.current, new Error('Matching workers closing'), undefined, true);
      retire(worker);
    }
    await Promise.all(closing.map((worker) => worker.exited));
  } finally {
    if (key === undefined) closingAll--;
    else {
      const count = (closingScopes.get(key) ?? 1) - 1;
      if (count) closingScopes.set(key, count);
      else closingScopes.delete(key);
    }
    drain();
  }
}
function validateReply(raw: unknown, job: MatchingJob): MatchingReply {
  if (
    Buffer.byteLength(JSON.stringify(raw)) >
    (job.operation === 'artwork' ? 3 * 1024 * 1024 : 512 * 1024)
  )
    throw new Error('Response too large');
  const reply = raw as MatchingReply;
  if (!reply || !Array.isArray(reply.plugins) || reply.plugins.length > 64)
    throw new Error('Invalid host response');
  for (const plugin of reply.plugins) {
    if (
      !plugin ||
      !/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(plugin.id) ||
      typeof plugin.name !== 'string' ||
      plugin.name.length > 80 ||
      !['provider', 'manager'].includes(plugin.kind) ||
      !Array.isArray(plugin.capabilities) ||
      plugin.capabilities.some((c) => !PROVIDER_CAPABILITIES.includes(c)) ||
      typeof plugin.network !== 'boolean'
    )
      throw new Error('Invalid plugin');
  }
  if (
    job.operation === 'artwork' &&
    (typeof reply.artwork !== 'string' ||
      reply.artwork.length > Math.ceil((2 * 1024 * 1024) / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.artwork))
  )
    throw new Error('Invalid artwork');
  if (
    job.operation === 'cheats' &&
    (typeof reply.file !== 'string' ||
      reply.file.length > 350000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.file))
  )
    throw new Error('Invalid cheat file');
  if (job.operation === 'match') {
    if (
      !reply.result ||
      !Array.isArray(reply.result.candidates) ||
      reply.result.candidates.length > 100 ||
      !Array.isArray(reply.result.problems) ||
      reply.result.problems.length > 32
    )
      throw new Error('Invalid matching result');
    reply.result.candidates = reply.result.candidates.map((c) => {
      const provider = reply.plugins.find((p) => p.id === c.providerId && p.kind === 'provider');
      if (!provider || (provider.network && !job.input?.online))
        throw new Error('Invalid provider');
      const candidate = validateCandidates([c], provider.capabilities)[0];
      if (!candidate) throw new Error('Invalid candidate');
      return {
        ...candidate,
        providerId: provider.id,
      };
    });
    for (const problem of reply.result.problems)
      if (
        problem.code !== 'provider-failed' ||
        !reply.plugins.some((p) => p.id === problem.providerId)
      )
        throw new Error('Invalid problem');
  }
  return reply;
}
