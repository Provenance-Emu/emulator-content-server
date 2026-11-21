import type {
  ContentClient,
  LibraryJob,
  LibraryJobItem,
  LibraryJobScope,
  MatchingOptions,
} from '@ecs/client';
import { ContentError } from '@ecs/client';
import { writable } from 'svelte/store';
import { readBatches } from './batches.js';
import { explain } from './problems.js';

export function createLibraryJobs(
  client: Pick<
    ContentClient,
    | 'libraryJobs'
    | 'libraryJob'
    | 'libraryJobItems'
    | 'createLibraryJob'
    | 'cancelLibraryJob'
    | 'resumeLibraryJob'
    | 'reviewLibraryJobItem'
  >,
  scope: LibraryJobScope,
  hooks: {
    changed?: () => void;
    rejected?: (status: 401 | 403) => void;
    initialJobId?: string;
  } = {},
) {
  let current: {
    jobs: LibraryJob[];
    selectedId: string | null;
    items: LibraryJobItem[];
    nextCursor: string | null;
    nextJobsCursor: string | null;
    loading: boolean;
    loadingMore: boolean;
    failure: string | null;
  } = {
    jobs: [],
    selectedId: hooks.initialJobId ?? null,
    items: [],
    nextCursor: null,
    nextJobsCursor: null,
    loading: false,
    loadingMore: false,
    failure: null,
  };
  const store = writable(current);
  let disposed = false,
    denied = false,
    refreshing = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let historyExpanded = false;
  let itemEpoch = 0,
    status: string | undefined = 'review',
    // How many batches of results are shown. A refresh reads that many again.
    depth = 1;
  const distinct = (rows: LibraryJobItem[]) => [
    ...new Map(rows.map((row) => [row.sourceId, row])).values(),
  ];
  const batch = (id: string, cursor?: string) =>
    client.libraryJobItems(id, {
      limit: 20,
      ...(status ? { status } : {}),
      ...(cursor ? { cursor } : {}),
    });
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
  /** Reads everything shown again, so a result that changed or moved is where it belongs. */
  async function items() {
    if (!current.selectedId || disposed || denied) return;
    const epoch = ++itemEpoch,
      id = current.selectedId;
    try {
      const page = await readBatches(depth, (cursor) => batch(id, cursor));
      if (epoch === itemEpoch && id === current.selectedId)
        update({ items: distinct(page.items), nextCursor: page.nextCursor });
    } catch (error) {
      if (epoch === itemEpoch) fail(error);
    }
  }
  /** Adds the next batch below what is shown. A refresh that starts meanwhile wins. */
  async function more() {
    const id = current.selectedId,
      from = current.nextCursor;
    if (!id || !from || current.loadingMore || disposed || denied) return;
    const epoch = ++itemEpoch;
    update({ loadingMore: true, failure: null });
    try {
      const page = await batch(id, from);
      if (epoch === itemEpoch && id === current.selectedId) {
        depth++;
        update({ items: distinct([...current.items, ...page.items]), nextCursor: page.nextCursor });
      }
    } catch (error) {
      if (epoch === itemEpoch) fail(error);
    } finally {
      update({ loadingMore: false });
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
      const previous = current.jobs.find((j) => j.id === selectedId);
      let next = result.jobs.find((j) => j.id === selectedId);
      if (selectedId && !next) next = (await client.libraryJob(selectedId)).job;
      if (disposed || denied) return;
      const retained = historyExpanded
        ? current.jobs
        : current.jobs.filter((job) => job.id === selectedId);
      const jobs = [
        ...new Map(
          [...retained, ...result.jobs, ...(next ? [next] : [])].map((job) => [job.id, job]),
        ).values(),
      ];
      jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      update({
        jobs,
        selectedId,
        failure: null,
        ...(!historyExpanded ? { nextJobsCursor: result.nextCursor } : {}),
      });
      if (previous?.updatedAt !== next?.updatedAt) {
        if (
          (next && previous && next.saved !== previous.saved) ||
          (next?.kind === 'scan' && next.state === 'completed' && previous?.state !== 'completed')
        )
          hooks.changed?.();
        await items();
      } else if (!current.items.length && selectedId) await items();
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
      // Marking one result reviewed keeps the list where it was; another job starts a new list.
      const same = job.id === current.selectedId;
      if (!same) depth = 1;
      update({
        jobs: [job, ...current.jobs.filter((j) => j.id !== job.id)].slice(0, 20),
        selectedId: job.id,
        ...(same ? {} : { items: [], nextCursor: null }),
      });
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
    async older() {
      if (disposed || denied || current.loading || !current.nextJobsCursor) return;
      const before = current.nextJobsCursor;
      update({ loading: true, failure: null });
      try {
        const page = await client.libraryJobs({ limit: 20, cursor: before });
        if (disposed || denied) return;
        historyExpanded = true;
        update({
          jobs: [...new Map([...current.jobs, ...page.jobs].map((job) => [job.id, job])).values()],
          nextJobsCursor: page.nextCursor,
        });
      } catch (error) {
        fail(error);
      } finally {
        update({ loading: false });
      }
    },
    async choose(id: string) {
      itemEpoch++;
      depth = 1;
      update({ selectedId: id, items: [], nextCursor: null });
      await items();
    },
    async filter(value: string) {
      status = value || undefined;
      depth = 1;
      await items();
    },
    more,
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
