import type { ContentClient } from '@ecs/client';
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
  let cursor = '0';
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
      for (;;) {
        const page = await client.changes({ cursor, limit: 100 });
        if (disposed) return;
        changed ||= page.changes.length > 0;
        if (page.nextCursor === cursor) break;
        cursor = page.nextCursor;
      }
    } catch (error) {
      if (disposed) return;
      if (isUnauthorized(error)) {
        dispose();
        options.unauthorized();
        return;
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
