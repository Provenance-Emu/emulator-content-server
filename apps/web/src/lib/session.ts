/**
 * The signed-in session, kept across reloads.
 *
 * This stores the bearer token the API already uses rather than setting a
 * cookie. A cookie rides along with every request the browser makes, which is
 * the thing that makes CSRF possible, and the API is bearer-authenticated for
 * the native clients anyway. The cost of storing it is that injected script
 * could read it, which is what the content policy on these assets answers.
 */
const KEY = 'ecs.session';

export interface StoredSession {
  token: string;
  expiresAt: string;
}

/** The stored session, or null when there is none or it has already expired. */
export function loadSession(): StoredSession | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredSession;
    if (!stored.token || !(Date.parse(stored.expiresAt) > Date.now())) {
      clearSession();
      return null;
    }
    return stored;
  } catch {
    clearSession();
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(KEY, JSON.stringify({ token: session.token, expiresAt: session.expiresAt }));
}

export function clearSession(): void {
  localStorage.removeItem(KEY);
}
