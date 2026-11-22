import { type ContentClient, ContentError } from '@ecs/client';
import { isUnauthorized } from './problems.js';

export interface PollScheduler {
  setTimeout(task: () => void | Promise<void>, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultPollScheduler: PollScheduler = {
  setTimeout: (task, milliseconds) =>
    globalThis.setTimeout(() => {
      void task();
    }, milliseconds),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ChangeWatchOptions {
  invalidate(): void;
  snapshot?: boolean;
  unauthorized(): void;
  /** null means the application drives poll() on its single shared cadence. */
  scheduler?: PollScheduler | null;
}

export interface ChangeWatch {
  start(): Promise<void>;
  poll(): Promise<void>;
  dispose(): void;
}

/** One cursor per authentication lifetime. No discovery, scans, or content reads. */
export function createChangeWatch(client: ContentClient, options: ChangeWatchOptions): ChangeWatch {
  const scheduler = options.scheduler === undefined ? defaultPollScheduler : options.scheduler;
  let cursor = options.snapshot ? 'now' : '0';
  let legacy = false;
  let retryAt = 0;
  let started = false;
  let disposed = false;
  let pending: Promise<void> | null = null;
  let timer: { handle: unknown } | null = null;

  function clearTimer() {
    if (timer) scheduler?.clearTimeout(timer.handle);
    timer = null;
  }
  function dispose() {
    disposed = true;
    clearTimer();
  }
  async function catchUp() {
    let changed = false;
    try {
      if (legacy || Date.now() < retryAt) return;
      for (let batch = 0; batch < 4; batch++) {
        const page = await client.changes({ cursor, limit: 100 });
        if (disposed) return;
        const initializing = cursor === 'now';
        changed ||= initializing || page.changes.length > 0;
        if (page.nextCursor === cursor) break;
        cursor = page.nextCursor;
        if (initializing || page.changes.length === 0) break;
      }
    } catch (error) {
      if (disposed) return;
      if (isUnauthorized(error)) {
        dispose();
        options.unauthorized();
        return;
      }
      if (error instanceof ContentError) {
        if (cursor === 'now' && error.status === 400) legacy = true;
        if (error.status === 429) retryAt = Date.now() + (error.retryAfterMs ?? 60_000);
      }
      // Keep the last applied cursor. The next cadence retries transient errors.
    } finally {
      if (!disposed && changed) options.invalidate();
    }
  }
  function poll(): Promise<void> {
    if (disposed || !started) return Promise.resolve();
    if (pending) return pending;
    clearTimer();
    pending = catchUp().finally(() => {
      pending = null;
      if (!disposed && scheduler) {
        timer = { handle: scheduler.setTimeout(poll, 15_000) };
      }
    });
    return pending;
  }
  return {
    start() {
      if (disposed) return Promise.resolve();
      if (started) return pending ?? Promise.resolve();
      started = true;
      return poll();
    },
    poll,
    dispose,
  };
}
