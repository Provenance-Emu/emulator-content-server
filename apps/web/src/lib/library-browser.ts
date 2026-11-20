import {
  type BrowseCategory,
  type BrowseSort,
  type ContentClient,
  ContentError,
  type LibraryBrowseEntry,
  type LibraryScope,
  type SystemCount,
} from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { explain } from './problems.js';
export interface BrowseFilters {
  category: BrowseCategory;
  search: string;
  systemId: string;
  systemIds: string[];
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
  systemCounts: SystemCount[];
  /** More of this collection is waiting on the server. */
  hasMore: boolean;
  /** The first read, or a re-read of everything already on screen. */
  loading: boolean;
  /** The next batch is being added below the ones already shown. */
  loadingMore: boolean;
  failure: string | null;
  status: number | null;
  requiresRefresh: boolean;
  active: LibraryBrowseEntry | null;
}
export interface LibraryBrowserController extends Readable<LibraryBrowserState> {
  selectScope(scope: LibraryScope | null): Promise<void>;
  setQuery(filters: Partial<BrowseFilters>): Promise<void>;
  /** Adds the next batch below the entries already shown. */
  more(): Promise<void>;
  refresh(options?: { restart?: boolean; clear?: boolean }): Promise<void>;
  open(entry: LibraryBrowseEntry, position: ReturnPosition): void;
  back(): ReturnPosition | null;
  dispose(): void;
}
const defaults = (): BrowseFilters => ({
  category: 'games',
  search: '',
  systemId: '',
  systemIds: [],
  rootId: '',
  sort: 'name_asc',
  view: 'grid',
});

const BATCH = 50;
/** Extra batches a refresh reads when the open game is no longer among the ones on screen. */
const SEARCH_BATCHES = 3;
const key = (entry: LibraryBrowseEntry) => `${entry.entityType}:${entry.id}`;

/**
 * Reads the collection in bounded batches and keeps what has been read, so the page can
 * keep scrolling. The application owns discovery and invalidation cadence.
 */
export function createLibraryBrowser(
  client: ContentClient,
  scope: LibraryScope | null,
): LibraryBrowserController {
  let current: LibraryBrowserState = {
    scope,
    filters: defaults(),
    items: [],
    systemCounts: [],
    hasMore: false,
    loading: false,
    loadingMore: false,
    failure: null,
    status: null,
    requiresRefresh: false,
    active: null,
  };
  const store = writable(current);
  /** Batches currently on screen; a re-read fetches this many again from the start. */
  let batches = 0;
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
    batches = 0;
    nextCursor = null;
    position = null;
    update({
      items: [],
      systemCounts: [],
      active: null,
      hasMore: false,
      loading: false,
      loadingMore: false,
      failure: null,
      status: null,
      requiresRefresh: false,
    });
  }
  /**
   * `append` adds one batch after the last one. Otherwise every batch already on screen is
   * read again from the start and swapped in together, so a refresh never empties the page.
   */
  function read(append: boolean): Promise<void> {
    const selected = current.scope;
    if (disposed || !selected) return Promise.resolve();
    const run = ++epoch;
    const filters = current.filters;
    update({ loading: !append, loadingMore: append, failure: null, status: null });
    const operation = (async () => {
      try {
        const wanted = append ? 1 : Math.max(1, batches);
        let cursor = append ? nextCursor : null;
        const fetched: LibraryBrowseEntry[] = [];
        let systemCounts = current.systemCounts;
        let count = 0;
        // The game that is open. A rename or new details can sort it past what was on screen.
        const open = append ? null : current.active;
        const isOpen = (entry: LibraryBrowseEntry) =>
          !!open && entry.entityType === open.entityType && entry.id === open.id;
        let found = false;
        do {
          const result = await client.browse({
            ...selected,
            category: filters.category,
            search: filters.search || undefined,
            systemId: filters.systemId || undefined,
            systemIds: filters.systemIds.length ? filters.systemIds : undefined,
            rootId: filters.rootId || undefined,
            sort: filters.sort,
            limit: BATCH,
            cursor: cursor ?? undefined,
          });
          if (disposed || run !== epoch) return;
          fetched.push(...result.items);
          found ||= result.items.some(isOpen);
          if (count === 0) systemCounts = result.systemCounts ?? [];
          cursor = result.nextCursor;
          count++;
          // Look a little further for the open game before giving up on finding it.
        } while (
          cursor !== null &&
          (count < wanted || (!!open && !found && count < wanted + SEARCH_BATCHES))
        );
        // Entries already shown keep their identity so their covers are not fetched again. A
        // row that moved between two reads is shown once.
        const seen = new Set(append ? current.items.map(key) : []);
        const fresh = fetched.filter((entry) => !seen.has(key(entry)) && !!seen.add(key(entry)));
        const items = append ? [...current.items, ...fresh] : fresh;
        batches = append ? batches + 1 : count;
        nextCursor = cursor;
        const active = current.active
          ? (items.find(
              (entry) =>
                entry.entityType === current.active?.entityType && entry.id === current.active.id,
            ) ??
            // Not in what was read, but there is more: it may only have moved further down, so
            // it stays open. Its own page still checks that it exists and may be read.
            (open && cursor !== null ? open : null))
          : null;
        if (!active) position = null;
        update({
          items,
          systemCounts,
          hasMore: nextCursor !== null,
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
            systemCounts: [],
            active: null,
            hasMore: false,
            requiresRefresh: invalid,
          });
        }
        update({ failure: explain(error), status });
      } finally {
        if (!disposed && run === epoch) {
          pending = null;
          update({ loading: false, loadingMore: false });
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
      return read(false);
    },
    setQuery(patch) {
      if (disposed) return Promise.resolve();
      const filters = {
        ...current.filters,
        ...patch,
        ...(patch.systemIds
          ? { systemId: '' }
          : patch.systemId !== undefined
            ? { systemIds: [] }
            : {}),
      };
      const changed = (
        ['category', 'search', 'systemId', 'systemIds', 'rootId', 'sort'] as const
      ).some((key) => JSON.stringify(filters[key]) !== JSON.stringify(current.filters[key]));
      update({ filters });
      if (!changed) return Promise.resolve();
      clear();
      return read(false);
    },
    more() {
      if (disposed || pending || current.requiresRefresh || !current.hasMore)
        return Promise.resolve();
      return read(true);
    },
    refresh(options = {}) {
      if (disposed) return Promise.resolve();
      if (options.restart) {
        clear();
        return read(false);
      }
      if (options.clear) {
        // Access rejection invalidates old requests and bodies without losing the saved query.
        epoch++;
        pending = null;
        position = null;
        update({ items: [], active: null });
      }
      if (current.requiresRefresh) return Promise.resolve();
      return pending ?? read(false);
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
