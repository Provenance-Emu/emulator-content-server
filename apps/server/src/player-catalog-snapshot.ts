import { createHash } from 'node:crypto';
import type { TrustedPlayer } from './player-catalog.js';

/** Canonical JSON covers every descriptor field, not just mutable download URLs. */
export function catalogJson(value: unknown): string {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, ordered(item)]),
      );
    return value;
  }
  return JSON.stringify(ordered(normalized));
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

export interface PlayerCatalogSnapshot {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly entries: readonly TrustedPlayer[];
}

export function playerCatalogEntryId(entry: TrustedPlayer): string {
  return createHash('sha256').update(catalogJson(entry)).digest('hex');
}

export function createPlayerCatalogSnapshot(
  entries: readonly TrustedPlayer[],
): PlayerCatalogSnapshot {
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    throw new Error('Duplicate player catalog identifier');
  const serialized = catalogJson({ schemaVersion: 1, entries });
  return freeze({
    ...JSON.parse(serialized),
    id: createHash('sha256').update(serialized).digest('hex'),
  });
}
