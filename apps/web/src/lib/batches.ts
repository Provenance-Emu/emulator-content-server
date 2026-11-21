export interface Batch<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Reads up to `count` batches from the start, following each cursor, as one list. A list that
 * has grown by showing more is read again this way, so nothing shown falls out of step.
 */
export async function readBatches<T>(
  count: number,
  read: (cursor?: string) => Promise<Batch<T>>,
): Promise<Batch<T>> {
  const items: T[] = [];
  let cursor: string | undefined;
  let nextCursor: string | null = null;
  for (let index = 0; index < Math.max(1, count); index++) {
    const batch = await read(cursor);
    items.push(...batch.items);
    nextCursor = batch.nextCursor;
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return { items, nextCursor };
}

/** How much of a list is shown, for the foot of the list. `nouns` is singular, then plural. */
export function shownLabel(
  shown: number,
  more: boolean,
  nouns: readonly [string, string],
  total?: number,
): string {
  if (!more) return `${shown.toLocaleString()} ${nouns[shown === 1 ? 0 : 1]}`;
  return total !== undefined && total > shown
    ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}`
    : `Showing the first ${shown.toLocaleString()}`;
}
