/** Credentials stay in the injected store/client, never in application view state. */
const KEY = 'ecs.session';

export interface StoredSession {
  token: string;
  expiresAt: string;
}

export interface SessionStore {
  load(): StoredSession | null;
  save(value: StoredSession): void;
  clear(): void;
  /** Optional cross-window notification; subscribers load the current scoped value. */
  subscribe?(listener: () => void): () => void;
}

function browserOrigin(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.origin;
}

function read(storage: Storage, key: string): StoredSession | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const stored = value as Partial<StoredSession>;
      if (
        typeof stored.token === 'string' &&
        stored.token.length > 0 &&
        typeof stored.expiresAt === 'string' &&
        Date.parse(stored.expiresAt) > Date.now()
      )
        return { token: stored.token, expiresAt: stored.expiresAt };
    }
  } catch {
    /* Invalid stored data is removed rather than sent as credentials. */
  }
  storage.removeItem(key);
  return null;
}

/** Desktop can supply its own storage/namespace; only the current browser migrates legacy data. */
export function createSessionStore(
  origin: string,
  options: { storage?: Storage; namespace?: string; browserOrigin?: string } = {},
): SessionStore {
  const storage = options.storage ?? localStorage;
  const namespace = options.namespace ?? KEY;
  const canonical = new URL(origin).origin;
  const current = options.browserOrigin ?? browserOrigin();
  const migrate =
    namespace === KEY && current !== undefined && new URL(current).origin === canonical;
  const key = `${namespace}:${encodeURIComponent(canonical)}`;
  return {
    load() {
      if (migrate) {
        if (storage.getItem(key) === null) {
          const legacy = read(storage, KEY);
          if (legacy) storage.setItem(key, JSON.stringify(legacy));
        }
        storage.removeItem(KEY);
      }
      return read(storage, key);
    },
    save(value) {
      storage.setItem(key, JSON.stringify({ token: value.token, expiresAt: value.expiresAt }));
      if (migrate) storage.removeItem(KEY);
    },
    clear() {
      storage.removeItem(key);
      if (migrate) storage.removeItem(KEY);
    },
  };
}

/** Compatibility for the existing browser shell until it receives an injected context. */
export function loadSession(): StoredSession | null {
  const origin = browserOrigin();
  return origin ? createSessionStore(origin).load() : read(localStorage, KEY);
}

export function saveSession(value: StoredSession): void {
  const origin = browserOrigin();
  if (origin) createSessionStore(origin).save(value);
  else
    localStorage.setItem(KEY, JSON.stringify({ token: value.token, expiresAt: value.expiresAt }));
}

export function clearSession(): void {
  const origin = browserOrigin();
  if (origin) createSessionStore(origin).clear();
  else localStorage.removeItem(KEY);
}
