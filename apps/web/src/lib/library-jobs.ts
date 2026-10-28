import type {
  ContentClient,
  LibraryJob,
  LibraryJobItem,
  LibraryScope,
  MatchingOptions,
} from '@ecs/client';
import { ContentError } from '@ecs/client';
import { writable } from 'svelte/store';
import { explain } from './problems.js';

export function createLibraryJobs(
  client: Pick<
    ContentClient,
    | 'libraryJobs'
    | 'libraryJobItems'
    | 'createLibraryJob'
    | 'cancelLibraryJob'
    | 'resumeLibraryJob'
    | 'reviewLibraryJobItem'
  >,
  scope: LibraryScope,
  hooks: { changed?: () => void; rejected?: (status: 401 | 403) => void } = {},
) {
  let current: {
    jobs: LibraryJob[];
    selectedId: string | null;
    items: LibraryJobItem[];
    nextCursor: string | null;
    loading: boolean;
    failure: string | null;
  } = {
    jobs: [],
    selectedId: null,
    items: [],
    nextCursor: null,
    loading: false,
    failure: null,
  };
  const store = writable(current);
  let disposed = false,
    denied = false,
    refreshing = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let itemEpoch = 0,
    status: string | undefined = 'review',
    cursor: string | undefined;
  const update = (patch: Partial<typeof current>) => {
    if (!disposed && !denied) {
      current = { ...current, ...patch };
      store.set(current);
    }
  };
  function fail(error: unknown) {
    if (disposed || denied) return;
    update({ failure: explain(error) });
    if (error instanceof ContentError && (error.status === 401 || error.status === 403)) {
      denied = true;
      clearTimeout(timer);
      itemEpoch++;
      current = { ...current, jobs: [], items: [], selectedId: null };
      store.set(current);
      hooks.rejected?.(error.status);
    }
  }
  async function items(next?: string) {
    if (!current.selectedId || disposed || denied) return;
    const epoch = ++itemEpoch,
      id = current.selectedId;
    cursor = next;
    try {
      const page = await client.libraryJobItems(id, {
        limit: 20,
        ...(status ? { status } : {}),
        ...(next ? { cursor: next } : {}),
      });
      if (epoch === itemEpoch && id === current.selectedId)
        update({ items: page.items, nextCursor: page.nextCursor });
    } catch (error) {
      if (epoch === itemEpoch) fail(error);
    }
  }
  async function refresh() {
    if (disposed || denied || refreshing) return;
    refreshing = true;
    try {
      const result = await client.libraryJobs({ limit: 20 });
      if (disposed || denied) return;
      const selectedId =
        current.selectedId ??
        result.jobs.find((j) => ['queued', 'running'].includes(j.state))?.id ??
        result.jobs[0]?.id ??
        null;
      const previous = current.jobs.find((j) => j.id === selectedId),
        next = result.jobs.find((j) => j.id === selectedId);
      update({ jobs: result.jobs, selectedId, failure: null });
      if (previous?.updatedAt !== next?.updatedAt) {
        if (
          (next && previous && next.saved !== previous.saved) ||
          (next?.kind === 'scan' && next.state === 'completed' && previous?.state !== 'completed')
        )
          hooks.changed?.();
        await items(cursor);
      } else if (!current.items.length && selectedId) await items(cursor);
    } catch (error) {
      fail(error);
    } finally {
      refreshing = false;
    }
  }
  async function action(work: () => Promise<{ job: LibraryJob }>) {
    if (disposed || denied || current.loading) return;
    update({ loading: true, failure: null });
    try {
      const { job } = await work();
      update({
        jobs: [job, ...current.jobs.filter((j) => j.id !== job.id)].slice(0, 20),
        selectedId: job.id,
        items: [],
        nextCursor: null,
      });
      cursor = undefined;
      await items();
      hooks.changed?.();
    } catch (error) {
      fail(error);
    } finally {
      update({ loading: false });
    }
  }
  async function poll() {
    await refresh();
    if (!disposed && !denied) timer = setTimeout(() => void poll(), 2000);
  }
  return {
    subscribe: store.subscribe,
    connect() {
      void poll();
    },
    refresh,
    async choose(id: string) {
      itemEpoch++;
      update({ selectedId: id, items: [], nextCursor: null });
      await items();
    },
    async filter(value: string) {
      status = value || undefined;
      await items();
    },
    next() {
      return current.nextCursor ? items(current.nextCursor) : Promise.resolve();
    },
    first() {
      return items();
    },
    start(kind: 'match' | 'scan', options: MatchingOptions = {}) {
      return action(() => client.createLibraryJob({ kind, ...scope, options }));
    },
    cancel(id: string) {
      return action(() => client.cancelLibraryJob(id));
    },
    resume(id: string, retry?: 'failed' | 'unmatched') {
      return action(() => client.resumeLibraryJob(id, retry));
    },
    reviewed(sourceId: string) {
      const id = current.selectedId;
      return id ? action(() => client.reviewLibraryJobItem(id, sourceId)) : Promise.resolve();
    },
    dispose() {
      disposed = true;
      itemEpoch++;
      clearTimeout(timer);
    },
  };
}
