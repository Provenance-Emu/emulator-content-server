import {
  type ContentClient,
  ContentError,
  type LibraryBrowseEntry,
  type LibraryBrowsePage,
} from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { createPreviews } from './previews.js';

/** What the home page shows for one library: how many games, and a few covers. */
export interface LibraryTile {
  /** Readable games in the library; null when the server did not report counts. */
  count: number | null;
  covers: LibraryBrowseEntry[];
}
export interface LibraryTilesState {
  tiles: Record<string, LibraryTile>;
  /** Object URLs keyed like the collection grid's previews (`entryKey`). */
  urls: Record<string, string>;
}
export interface LibraryTilesController extends Readable<LibraryTilesState> {
  load(libraryIds: string[]): Promise<void>;
  dispose(): void;
}
const COVERS = 4;
/** One page is enough to find a few covers; the count comes from the page's system totals. */
const PAGE = 24;

function hasArtwork(entry: LibraryBrowseEntry): boolean {
  return entry.entityType === 'source'
    ? entry.source?.artworkAvailable === true
    : entry.entityType === 'item' && entry.previewAsset?.kind === 'artwork';
}

export function tileFromPage(page: LibraryBrowsePage): LibraryTile {
  return {
    count: page.systemCounts ? page.systemCounts.reduce((sum, row) => sum + row.count, 0) : null,
    covers: page.items.filter(hasArtwork).slice(0, COVERS),
  };
}

export function gameCountLabel(count: number | null): string {
  if (count === null) return '';
  if (count === 0) return 'No games yet';
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'game' : 'games'}`;
}

/** Uses the same authorized browse the collection uses, so a tile never counts a game its viewer cannot open. */
export function createLibraryTiles(
  client: ContentClient,
  options: { authorizationRejected?(status: 401 | 403): void } = {},
): LibraryTilesController {
  let current: LibraryTilesState = { tiles: {}, urls: {} };
  const store = writable(current);
  const previews = createPreviews(client, options);
  const stop = previews.subscribe((state) => {
    current = { ...current, urls: state.urls };
    store.set(current);
  });
  let epoch = 0;
  let disposed = false;
  return {
    subscribe: store.subscribe,
    async load(libraryIds) {
      if (disposed) return;
      const run = ++epoch;
      const pages = await Promise.all(
        libraryIds.map(async (libraryId) => {
          try {
            return [
              libraryId,
              tileFromPage(await client.browse({ libraryId, category: 'games', limit: PAGE })),
            ] as const;
          } catch (error) {
            if (
              !disposed &&
              run === epoch &&
              error instanceof ContentError &&
              (error.status === 401 || error.status === 403)
            )
              options.authorizationRejected?.(error.status);
            // A library that cannot be summarised keeps its plain tile.
            return null;
          }
        }),
      );
      if (disposed || run !== epoch) return;
      const tiles = Object.fromEntries(pages.filter((row) => row !== null));
      current = { ...current, tiles };
      store.set(current);
      await previews.setPage(Object.values(tiles).flatMap((tile) => tile.covers));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      previews.dispose();
    },
  };
}
