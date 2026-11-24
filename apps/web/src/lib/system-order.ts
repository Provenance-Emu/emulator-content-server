import { writable } from 'svelte/store';

const KEY = 'ecs.recentSystems';
/** How many recently opened systems lead the filter row. */
export const RECENT_SYSTEMS = 3;

interface OrderStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function available(storage?: OrderStorage): OrderStorage | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage can be blocked; the row is then ordered by size alone.
    return null;
  }
}

export function readRecentSystems(storage?: OrderStorage): string[] {
  try {
    const value: unknown = JSON.parse(available(storage)?.getItem(KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id))].slice(
      0,
      RECENT_SYSTEMS,
    );
  } catch {
    return [];
  }
}

/** Opening a game puts its system at the front of the recent ones. */
export function withRecentSystem(recent: readonly string[], id: string | null | undefined) {
  if (!id || id === 'unknown') return [...recent];
  return [id, ...recent.filter((value) => value !== id)].slice(0, RECENT_SYSTEMS);
}

/**
 * The systems opened lately on this device come first, newest first; the rest follow with the
 * largest first, and equal sizes by name so the row does not shuffle between visits.
 */
export function orderSystems<T extends { systemId: string; count: number }>(
  counts: readonly T[],
  recent: readonly string[],
  label: (id: string) => string = (id) => id,
): T[] {
  const place = (id: string) => {
    const index = recent.indexOf(id);
    return index < 0 ? recent.length : index;
  };
  return [...counts].sort(
    (a, b) =>
      place(a.systemId) - place(b.systemId) ||
      b.count - a.count ||
      label(a.systemId).localeCompare(label(b.systemId)) ||
      a.systemId.localeCompare(b.systemId),
  );
}

/** A row this long is quicker to type into than to read. */
export const FIND_SYSTEMS_FROM = 8;

/**
 * The systems a typed fragment means: every word must appear in the name or the short
 * identifier, so "super" finds Super Nintendo and "snes" does too. Order is kept.
 */
export function findSystems<T extends { systemId: string }>(
  systems: readonly T[],
  query: string,
  label: (id: string) => string = (id) => id,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...systems];
  return systems.filter((system) => {
    const text =
      `${label(system.systemId)} ${system.systemId.split('.').pop() ?? ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** A row this long reads better in groups than as one run of names. */
export const GROUP_SYSTEMS_FROM = 12;

export interface SystemGroup<T> {
  /** Empty when the row is not grouped. */
  name: string;
  systems: T[];
}

/**
 * A long row split by who made each system. The systems opened lately lead as their own group so
 * they stay one glance away; makers follow with the most games first, and systems without a
 * maker close the row. A short row, or one where a single maker has everything, stays as it is.
 */
export function groupSystems<T extends { systemId: string; count: number }>(
  ordered: readonly T[],
  recent: readonly string[],
  maker: (id: string) => string | undefined,
): SystemGroup<T>[] {
  const makers = new Set(ordered.map((system) => maker(system.systemId) ?? ''));
  if (ordered.length < GROUP_SYSTEMS_FROM || makers.size < 2)
    return [{ name: '', systems: [...ordered] }];
  const lead = ordered.filter((system) => recent.includes(system.systemId));
  const groups = new Map<string, T[]>();
  for (const system of ordered) {
    if (lead.includes(system)) continue;
    const name = maker(system.systemId) ?? '';
    groups.set(name, [...(groups.get(name) ?? []), system]);
  }
  const total = (systems: readonly T[]) => systems.reduce((sum, system) => sum + system.count, 0);
  const named = [...groups]
    .filter(([name]) => name)
    .sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]))
    .map(([name, systems]) => ({ name, systems }));
  const other = groups.get('');
  return [
    ...(lead.length ? [{ name: 'Recent', systems: lead }] : []),
    ...named,
    ...(other ? [{ name: 'Other', systems: other }] : []),
  ];
}

export const recentSystems = writable(readRecentSystems());
export function noteSystem(id: string | null | undefined, storage?: OrderStorage): void {
  recentSystems.update((recent) => {
    const next = withRecentSystem(recent, id);
    try {
      available(storage)?.setItem(KEY, JSON.stringify(next));
    } catch {
      // The order still applies to this page.
    }
    return next;
  });
}
