import { invoke } from '@tauri-apps/api/core';
import type { StoredSession } from '../../../web/src/lib/session.js';
import type { LocalSignIn } from './access.js';

interface NativeSession {
  origin: string;
  token: string;
  expiresAt: string;
}

/**
 * The desktop shell reads the server's key and exchanges it itself; this page only ever sees
 * the resulting session. `origin` is compared in the shell, never used as a destination.
 */
export const localOwnerSignIn: LocalSignIn = async (origin) => {
  if (!('__TAURI_INTERNALS__' in window)) return null;
  const reply = await invoke<NativeSession | null>('local_owner_session', { origin });
  if (!reply || reply.origin !== origin) return null;
  const session: StoredSession = { token: reply.token, expiresAt: reply.expiresAt };
  return session;
};
