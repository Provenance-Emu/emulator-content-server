import { writable } from 'svelte/store';

/** The narrowest a cover in the game grid may be, in rem. The grid fits as many as it can. */
export const COVER_SIZE = { min: 5, max: 14, step: 0.5, initial: 8.5 } as const;

const KEY = 'ecs.coverSize';

interface SizeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function available(storage?: SizeStorage): SizeStorage | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage can be blocked; the grid then keeps its usual size.
    return null;
  }
}

/** Anything that is not a size on the slider reads as the usual size. */
export function coverSizeFrom(value: unknown): number {
  const size = typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(size)) return COVER_SIZE.initial;
  const stepped = Math.round(size / COVER_SIZE.step) * COVER_SIZE.step;
  return Math.min(COVER_SIZE.max, Math.max(COVER_SIZE.min, stepped));
}

export function readCoverSize(storage?: SizeStorage): number {
  try {
    return coverSizeFrom(available(storage)?.getItem(KEY));
  } catch {
    return COVER_SIZE.initial;
  }
}

export function saveCoverSize(value: number, storage?: SizeStorage): number {
  const size = coverSizeFrom(String(value));
  try {
    const target = available(storage);
    if (size === COVER_SIZE.initial) target?.removeItem(KEY);
    else target?.setItem(KEY, String(size));
  } catch {
    // The choice still applies to this page.
  }
  return size;
}

/** Shared by the slider and the grid, and kept for the next visit on this device. */
export const coverSize = writable(readCoverSize());
export function setCoverSize(value: number): void {
  coverSize.set(saveCoverSize(value));
}
