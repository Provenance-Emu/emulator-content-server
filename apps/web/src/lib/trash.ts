import type { ContentClient, TrashEntry } from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { explain, isForbidden, isUnauthorized } from './problems.js';

export type TrashClient = Pick<
  ContentClient,
  'trash' | 'deleteItem' | 'deleteFile' | 'restoreItem' | 'restoreFile'
>;

const DAY = 86_400_000;

/** Whole days until removal, rounded down so the page never promises time the server will not give. */
export function daysLeft(purgeAfter: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((Date.parse(purgeAfter) - now) / DAY));
}

export function timeLeft(purgeAfter: string, now: number = Date.now()): string {
  const days = daysLeft(purgeAfter, now);
  if (days === 0) return 'Removed within a day';
  return days === 1 ? '1 day left' : `${days} days left`;
}

export interface UndoToastState {
  message: string;
  canUndo: boolean;
  working: boolean;
  failure: string | null;
}

/** Starts a timer and returns how to cancel it. Replaced in tests. */
export type ToastTimer = (expire: () => void) => () => void;

const eightSeconds: ToastTimer = (expire) => {
  const timer = setTimeout(expire, 8000);
  return () => clearTimeout(timer);
};

/**
 * One message with one Undo. A newer message replaces it. The undo runs at most
 * once successfully; a failure stays visible and can be tried again.
 */
export function createUndoToast(timer: ToastTimer = eightSeconds) {
  const store = writable<UndoToastState | null>(null);
  let current: UndoToastState | null = null;
  let action: (() => Promise<string | undefined>) | null = null;
  let cancel: (() => void) | null = null;
  let generation = 0;
  function set(next: UndoToastState | null) {
    current = next;
    store.set(next);
  }
  function arm() {
    cancel?.();
    const mine = ++generation;
    cancel = timer(() => {
      if (mine === generation && !current?.working) dismiss();
    });
  }
  function dismiss() {
    cancel?.();
    cancel = null;
    generation++;
    action = null;
    set(null);
  }
  return {
    subscribe: store.subscribe as Readable<UndoToastState | null>['subscribe'],
    /** `undo` may return the message to show once it has run. */
    show(message: string, undo: () => Promise<string | undefined>) {
      action = undo;
      set({ message, canUndo: true, working: false, failure: null });
      arm();
    },
    async undo() {
      const run = action;
      if (!run || !current || current.working || !current.canUndo) return;
      cancel?.();
      set({ ...current, working: true, failure: null });
      try {
        const done = await run();
        if (action !== run) return;
        action = null;
        set({ message: done ?? 'Restored.', canUndo: false, working: false, failure: null });
      } catch (error) {
        if (action !== run || !current) return;
        set({ ...current, working: false, failure: explain(error) });
      }
      arm();
    },
    dismiss,
  };
}

export type UndoToast = ReturnType<typeof createUndoToast>;

/** The one toast the page shows. Mounted once by the shell. */
export const undoToast = createUndoToast();

export interface TrashTarget {
  kind: 'item' | 'file';
  id: string;
  name: string;
}

/**
 * Deletes and offers the undo. Returns what to tell the person when the delete
 * itself failed, or null when it worked.
 */
export async function moveToTrash(
  client: TrashClient,
  toast: UndoToast,
  target: TrashTarget,
  changed: () => void | Promise<void>,
): Promise<string | null> {
  try {
    if (target.kind === 'item') await client.deleteItem(target.id);
    else await client.deleteFile(target.id);
  } catch (error) {
    return explain(error);
  }
  toast.show(`Moved ${target.name} to the trash.`, async () => {
    if (target.kind === 'item') await client.restoreItem(target.id);
    else await client.restoreFile(target.id);
    await changed();
    return `${target.name} restored.`;
  });
  await changed();
  return null;
}

interface TrashState {
  entries: TrashEntry[];
  loaded: boolean;
  loading: boolean;
  more: boolean;
  restoring: string | null;
  failure: string | null;
  notice: string | null;
}

/** The Trash page: what can still be restored, and restoring it. */
export function createTrash(
  client: TrashClient,
  changed: () => void = () => {},
  rejected: (status: 401 | 403) => void = () => {},
) {
  let current: TrashState = {
    entries: [],
    loaded: false,
    loading: false,
    more: false,
    restoring: null,
    failure: null,
    notice: null,
  };
  const store = writable(current);
  let cursor: string | null = null;
  let disposed = false;
  function update(patch: Partial<TrashState>) {
    if (disposed) return;
    current = { ...current, ...patch };
    store.set(current);
  }
  function failed(error: unknown) {
    update({ failure: explain(error) });
    if (isUnauthorized(error)) rejected(401);
    else if (isForbidden(error)) rejected(403);
  }
  async function read(append: boolean) {
    if (current.loading) return;
    update({ loading: true, failure: null, ...(append ? {} : { notice: null }) });
    try {
      const page = await client.trash(append && cursor ? { cursor } : {});
      cursor = page.nextCursor;
      update({
        entries: append ? [...current.entries, ...page.entries] : page.entries,
        loaded: true,
        more: page.nextCursor !== null,
      });
    } catch (error) {
      failed(error);
    } finally {
      update({ loading: false });
    }
  }
  return {
    subscribe: store.subscribe,
    load: () => read(false),
    loadMore: () => read(true),
    async restore(entry: TrashEntry) {
      if (current.restoring) return;
      update({ restoring: entry.id, failure: null, notice: null });
      try {
        if (entry.kind === 'item') await client.restoreItem(entry.id);
        else await client.restoreFile(entry.id);
        update({
          // Files that were waiting on this game can be restored now.
          entries: current.entries
            .filter((item) => item.id !== entry.id)
            .map((item) =>
              entry.kind === 'item' && item.itemId === entry.id
                ? { ...item, itemDeleted: false }
                : item,
            ),
          notice: `${entry.name} restored.`,
        });
        changed();
      } catch (error) {
        failed(error);
      } finally {
        update({ restoring: null });
      }
    },
    dispose() {
      disposed = true;
    },
  };
}
