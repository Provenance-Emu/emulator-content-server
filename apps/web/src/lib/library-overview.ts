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
  if (!folder.games) return 'No indexed games yet.';
  if (!enabled) return 'Automatic lookup is off.';
  const missing = missingCount(folder);
  if (!missing) return 'All games have details and a cover.';
  const { state, jobState, processed, total, providerFailures, failed, unmatched, review } =
    folder.automatic;
  if (jobState === 'running')
    return `Looking up details and covers · ${processed} of ${total} checked.`;
  if (jobState === 'interrupted' || jobState === 'failed')
    return 'Lookup stopped. Open activity to see what happened.';
  if (jobState === 'queued' || state === 'waiting') return 'Lookup queued.';
  if (typeof providerFailures === 'number' && providerFailures > 0)
    return `Catalog lookups failed for ${providerFailures.toLocaleString()} games in the last batch.`;
  if (typeof failed === 'number' && failed > 0)
    return 'Some lookups failed. Open activity to retry.';
  if (typeof review === 'number' && review > 0) return 'Some matches need review.';
  if (typeof unmatched === 'number' && unmatched > 0)
    return 'Some games had no match in the last batch.';
  switch (state) {
    case 'unchanged':
      return 'Waiting for new file or game information, or a scheduled retry.';
    case 'queued':
      return 'Open activity for lookup results.';
    default:
      return 'Details or covers are missing.';
  }
}
