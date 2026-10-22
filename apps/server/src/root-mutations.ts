import type { CatalogDatabase } from '@ecs/database';
import { DomainError } from '@ecs/domain';

const held = new WeakMap<CatalogDatabase, Set<string>>();

/** Acquire all roots synchronously before inspection or filesystem writes. */
export function reserveContentRoots(
  catalog: CatalogDatabase,
  roots: readonly string[],
): () => void {
  let active = held.get(catalog);
  if (!active) {
    active = new Set();
    held.set(catalog, active);
  }
  const ids = [...new Set(roots)].sort();
  if (ids.some((id) => active.has(id)))
    throw new DomainError(
      'root-busy',
      409,
      'A folder scan or organization is in progress. Try again shortly.',
    );
  for (const id of ids) active.add(id);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of ids) active.delete(id);
  };
}
