export const themeChoices = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof themeChoices)[number];

const KEY = 'ecs.theme';

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface ThemeRoot {
  dataset: Record<string, string | undefined>;
}

function available(storage?: ThemeStorage): ThemeStorage | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage can be blocked; the page then follows the system appearance.
    return null;
  }
}

export function readTheme(storage?: ThemeStorage): ThemeChoice {
  try {
    const value = available(storage)?.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** "system" leaves the attribute off so the stylesheet follows prefers-color-scheme. */
export function applyTheme(choice: ThemeChoice, root: ThemeRoot = document.documentElement): void {
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

export function saveTheme(choice: ThemeChoice, storage?: ThemeStorage, root?: ThemeRoot): void {
  try {
    const target = available(storage);
    if (choice === 'system') target?.removeItem(KEY);
    else target?.setItem(KEY, choice);
  } catch {
    // The choice still applies to this page.
  }
  applyTheme(choice, root);
}
