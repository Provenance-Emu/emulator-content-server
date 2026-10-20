import {
  type BrowseCategory,
  type BrowseSort,
  type ContentClient,
  ContentError,
  type LibraryBrowseEntry,
  type LibraryScope,
} from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { explain } from './problems.js';
export interface BrowseFilters {
  category: BrowseCategory;
  search: string;
  systemId: string;
  rootId: string;
  sort: BrowseSort;
  view: 'grid' | 'list';
}
export interface ReturnPosition {
  scrollTop: number;
  focusKey: string;
}
export interface LibraryBrowserState {
  scope: LibraryScope | null;
  filters: BrowseFilters;
  items: LibraryBrowseEntry[];
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  loading: boolean;
  failure: string | null;
  status: number | null;
  requiresRefresh: boolean;
  active: LibraryBrowseEntry | null;
}
export interface LibraryBrowserController extends Readable<LibraryBrowserState> {
  selectScope(scope: LibraryScope | null): Promise<void>;
  setQuery(filters: Partial<BrowseFilters>): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  refresh(options?: { restart?: boolean }): Promise<void>;
  open(entry: LibraryBrowseEntry, position: ReturnPosition): void;
  back(): ReturnPosition | null;
  dispose(): void;
}
const defaults = (): BrowseFilters => ({
  category: 'games',
  search: '',
  systemId: '',
  rootId: '',
  sort: 'name_asc',
  view: 'grid',
});

/** Reads only the visible page. The application owns discovery and invalidation cadence. */
export function createLibraryBrowser(
  client: ContentClient,
  scope: LibraryScope | null,
): LibraryBrowserController {
  let current: LibraryBrowserState = {
    scope,
    filters: defaults(),
    items: [],
    page: 1,
    hasPrevious: false,
    hasNext: false,
    loading: false,
    failure: null,
    status: null,
    requiresRefresh: false,
    active: null,
  };
  const store = writable(current);
  let cursors: (string | null)[] = [null];
  let nextCursor: string | null = null;
  let position: ReturnPosition | null = null;
  let epoch = 0;
  let disposed = false;
  let pending: Promise<void> | null = null;
  function update(patch: Partial<LibraryBrowserState>) {
    current = { ...current, ...patch };
    store.set(current);
  }
  function clear() {
    epoch++;
    pending = null;
    cursors = [null];
    nextCursor = null;
    position = null;
    update({
      items: [],
      active: null,
      page: 1,
      hasPrevious: false,
      hasNext: false,
      loading: false,
      failure: null,
      status: null,
      requiresRefresh: false,
    });
  }
  function read(page: number, cursor: string | null): Promise<void> {
    const selected = current.scope;
    if (disposed || !selected) return Promise.resolve();
    const run = ++epoch;
    const filters = current.filters;
    update({ loading: true, failure: null, status: null });
    const operation = (async () => {
      try {
        const result = await client.browse({
          ...selected,
          category: filters.category,
          search: filters.search || undefined,
          systemId: filters.systemId || undefined,
          rootId: filters.rootId || undefined,
          sort: filters.sort,
          limit: 50,
          cursor: cursor ?? undefined,
        });
        if (disposed || run !== epoch) return;
        cursors = cursors.slice(0, page);
        cursors[page - 1] = cursor;
        nextCursor = result.nextCursor;
        const active = current.active
          ? (result.items.find(
              (entry) =>
                entry.entityType === current.active?.entityType && entry.id === current.active.id,
            ) ?? null)
          : null;
        if (!active) position = null;
        update({
          items: result.items,
          page,
          hasPrevious: page > 1,
          hasNext: nextCursor !== null,
          active,
          requiresRefresh: false,
        });
      } catch (error) {
        if (disposed || run !== epoch) return;
        const status = error instanceof ContentError ? error.status : null;
        const invalid =
          status === 400 &&
          error instanceof ContentError &&
          error.problem?.type.endsWith('invalid-cursor') === true;
        if (invalid || status === 401 || status === 403 || status === 404) {
          nextCursor = null;
          position = null;
          update({
            items: [],
            active: null,
            hasNext: false,
            hasPrevious: false,
            requiresRefresh: invalid,
          });
        }
        update({ failure: explain(error), status });
      } finally {
        if (!disposed && run === epoch) {
          pending = null;
          update({ loading: false });
        }
      }
    })();
    pending = operation;
    return operation;
  }
  return {
    subscribe: store.subscribe,
    selectScope(selected) {
      if (disposed || JSON.stringify(selected) === JSON.stringify(current.scope))
        return Promise.resolve();
      clear();
      update({ scope: selected, filters: { ...defaults(), view: current.filters.view } });
      return read(1, null);
    },
    setQuery(patch) {
      if (disposed) return Promise.resolve();
      const filters = { ...current.filters, ...patch };
      const changed = (['category', 'search', 'systemId', 'rootId', 'sort'] as const).some(
        (key) => filters[key] !== current.filters[key],
      );
      update({ filters });
      if (!changed) return Promise.resolve();
      clear();
      return read(1, null);
    },
    next() {
      if (disposed || pending || current.requiresRefresh || !current.hasNext)
        return Promise.resolve();
      return read(current.page + 1, nextCursor);
    },
    previous() {
      if (disposed || pending || current.requiresRefresh || !current.hasPrevious)
        return Promise.resolve();
      return read(current.page - 1, cursors[current.page - 2] ?? null);
    },
    refresh(options = {}) {
      if (disposed) return Promise.resolve();
      if (options.restart) {
        clear();
        return read(1, null);
      }
      if (current.requiresRefresh) return Promise.resolve();
      return pending ?? read(current.page, cursors[current.page - 1] ?? null);
    },
    open(entry, saved) {
      if (disposed) return;
      const active = current.items.find(
        (row) => row.entityType === entry.entityType && row.id === entry.id,
      );
      if (!active) return;
      position = { ...saved };
      update({ active });
    },
    back() {
      if (disposed || !current.active) return null;
      const saved = position;
      position = null;
      update({ active: null });
      return saved;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      update({ scope: null });
    },
  };
}
