import type { LibraryOverviewFolder } from '@ecs/client';

export interface OverviewTotals {
  games: number;
  withDetails: number;
  withCover: number;
  unavailable: number;
}

export function overviewTotals(folders: LibraryOverviewFolder[]): OverviewTotals {
  const totals = { games: 0, withDetails: 0, withCover: 0, unavailable: 0 };
  for (const folder of folders) {
    totals.games += folder.games;
    totals.withDetails += folder.withDetails;
    totals.withCover += folder.withCover;
    totals.unavailable += folder.unavailable;
  }
  return totals;
}

/** Games in a folder that still lack details or a cover; the larger gap, since one game can lack both. */
export function missingCount(folder: LibraryOverviewFolder): number {
  return Math.max(0, folder.games - Math.min(folder.withDetails, folder.withCover));
}

/** One plain sentence for what the server did on its own, so a quiet folder is never ambiguous. */
export function automaticText(enabled: boolean, folder: LibraryOverviewFolder): string {
  if (!folder.games) return 'No games found yet. Scan this folder.';
  if (!enabled) return 'Automatic matching is off.';
  const missing = missingCount(folder);
  switch (folder.automatic.state) {
    case 'waiting':
      return 'Queued. Starts when current work finishes.';
    case 'queued':
      return missing
        ? 'Looked for details and covers. Some games still need review.'
        : 'Details and covers found automatically.';
    case 'complete':
      return 'Nothing missing.';
    case 'unchanged':
      return 'Some games still need details. Nothing has changed since the last try.';
    default:
      return missing ? 'Not checked since the server started.' : 'Nothing missing.';
  }
}
