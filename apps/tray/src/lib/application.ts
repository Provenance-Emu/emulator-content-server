import { ContentClient } from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import type { ServerContext } from '../../../web/src/lib/application.js';
import { createSessionStore } from '../../../web/src/lib/session.js';

export interface DesktopProfile {
  origin: string;
  label: string;
  /** An explicit profile identity; a manually entered loopback URL is never a managed service. */
  profileKey: string;
}
export interface DesktopContext extends ServerContext {
  readonly profile: Readonly<DesktopProfile>;
}
export interface DesktopEnvironment {
  storage?: Storage;
  events?: EventTarget;
  openExternal(url: string): void | Promise<void>;
}
const PROFILE_KEY = 'ecs.tray.profile';
const PROFILES_KEY = 'ecs.tray.servers';
const SESSION_NAMESPACE = 'ecs.desktop.session';
const CHANGE = 'ecs:desktop-storage';
let sequence = 0;

export function canonicalServerOrigin(value: string): string {
  try {
    const url = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error('Enter an http or https server address without a path or credentials.');
  }
}

/** Accept the computer name people see on their network as well as a full URL. */
export function connectionAddress(value: string): string {
  const text = value.trim();
  try {
    const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
    const url = new URL(explicit ? text : `http://${text}`);
    const explicitPort = /:\d+(?=[/?#]|$)/.test(text);
    if (!explicit && !url.port && !explicitPort) url.port = '8473';
    if (url.pathname === '/ui/' || url.pathname === '/ui') url.pathname = '/';
    return canonicalServerOrigin(url.href);
  } catch {
    throw new Error('Enter the computer’s name or the address of its library.');
  }
}

function environment(options: DesktopEnvironment) {
  return { ...options, storage: options.storage ?? localStorage, events: options.events ?? window };
}
function notify(events: EventTarget, key: string) {
  events.dispatchEvent(new CustomEvent(CHANGE, { detail: key }));
}
function listen(storage: Storage, events: EventTarget, key: string, change: () => void) {
  const local = (event: Event) => {
    if ((event as CustomEvent<string>).detail === key) change();
  };
  const remote = (event: Event) => {
    const stored = event as StorageEvent;
    if (stored.storageArea === storage && (stored.key === key || stored.key === null)) change();
  };
  events.addEventListener(CHANGE, local);
  events.addEventListener('storage', remote);
  return () => {
    events.removeEventListener(CHANGE, local);
    events.removeEventListener('storage', remote);
  };
}

/** Resolve only the isolated player route and its public selection IDs, never a bearer URL. */
export function playerUrl(origin: string, href: string): string {
  const base = canonicalServerOrigin(origin);
  const url = new URL(href, base);
  const allowed = new Set(['source', 'item', 'asset', 'profile']);
  if (
    !href.startsWith('/play/') ||
    url.origin !== base ||
    url.pathname !== '/play/' ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !allowed.has(key))
  ) {
    throw new Error('The player link must select content on this server.');
  }
  return url.href;
}

export function createDesktopContext(
  profile: DesktopProfile,
  options: DesktopEnvironment,
): DesktopContext {
  const origin = canonicalServerOrigin(profile.origin);
  const { storage, events, openExternal } = environment(options);
  // The old credential's issuing origin is unknown, so it must never be migrated.
  storage.removeItem('ecs.tray.session');
  const sessions = createSessionStore(origin, { storage, namespace: SESSION_NAMESPACE });
  const key = `${SESSION_NAMESPACE}:${encodeURIComponent(origin)}`;
  return {
    key: `desktop:${profile.profileKey}:${++sequence}`,
    profile: { ...profile, origin },
    origin,
    label: profile.label || origin,
    client: new ContentClient(origin),
    sessions: {
      load: () => sessions.load(),
      save(value) {
        sessions.save(value);
        notify(events, key);
      },
      clear() {
        sessions.clear();
        notify(events, key);
      },
      subscribe(listener) {
        return listen(storage, events, key, listener);
      },
    },
    openPlayer(href) {
      void openExternal(playerUrl(origin, href));
    },
  };
}

export interface DesktopSelection extends Readable<DesktopContext | null> {
  readonly profiles: Readable<DesktopProfile[]>;
  select(profile: DesktopProfile): void;
  dispose(): void;
}
/** Shared selection across bundled windows. Retire old clients synchronously, before rendering. */
export function createDesktopSelection(options: DesktopEnvironment): DesktopSelection {
  const { storage, events } = environment(options);
  let current: DesktopContext | null = null;
  let disposed = false;
  const state = writable<DesktopContext | null>(null);
  const profiles = writable<DesktopProfile[]>([]);
  const retire = () => {
    if (current) {
      current.client.setToken(undefined);
      current.key += ':retired';
    }
  };
  const read = (): DesktopProfile | null => {
    try {
      const raw = storage.getItem(PROFILE_KEY);
      if (raw) {
        const value = JSON.parse(raw) as DesktopProfile;
        if (
          typeof value.origin === 'string' &&
          typeof value.label === 'string' &&
          typeof value.profileKey === 'string'
        ) {
          return { ...value, origin: canonicalServerOrigin(value.origin) };
        }
      }
      const legacy = storage.getItem('ecs.tray.origin');
      if (legacy)
        return {
          origin: canonicalServerOrigin(legacy),
          label: canonicalServerOrigin(legacy),
          profileKey: 'manual',
        };
    } catch {
      /* Invalid old settings ask the operator for a server instead. */
    }
    return null;
  };
  function readProfiles(): DesktopProfile[] {
    const saved: DesktopProfile[] = [];
    try {
      const items: unknown = JSON.parse(storage.getItem(PROFILES_KEY) ?? '[]');
      if (!Array.isArray(items)) return saved;
      for (const item of items) {
        if (
          typeof item?.origin !== 'string' ||
          typeof item.label !== 'string' ||
          typeof item.profileKey !== 'string'
        )
          continue;
        try {
          saved.push({
            origin: canonicalServerOrigin(item.origin),
            label: item.label,
            profileKey: item.profileKey,
          });
        } catch {
          /* Ignore an invalid saved address. */
        }
      }
    } catch {
      /* The current selection still works if the saved list is damaged. */
    }
    return saved;
  }
  function withProfile(saved: DesktopProfile[], profile: DesktopProfile) {
    return [
      profile,
      ...saved.filter((item) =>
        profile.profileKey === 'managed-service'
          ? item.profileKey !== 'managed-service'
          : item.profileKey === 'managed-service' || item.origin !== profile.origin,
      ),
    ];
  }
  const load = () => {
    if (disposed) return;
    retire();
    const profile = read();
    current = profile ? createDesktopContext(profile, options) : null;
    const saved = readProfiles();
    profiles.set(profile ? withProfile(saved, profile) : saved);
    state.set(current);
  };
  load();
  const unsubscribe = listen(storage, events, PROFILE_KEY, load);
  return {
    subscribe: state.subscribe,
    profiles: { subscribe: profiles.subscribe },
    select(profile) {
      if (disposed) return;
      const canonical = { ...profile, origin: canonicalServerOrigin(profile.origin) };
      const previous = read();
      const saved = readProfiles();
      storage.setItem(
        PROFILES_KEY,
        JSON.stringify(withProfile(previous ? withProfile(saved, previous) : saved, canonical)),
      );
      storage.setItem(PROFILE_KEY, JSON.stringify(canonical));
      storage.removeItem('ecs.tray.origin');
      notify(events, PROFILE_KEY);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      retire();
    },
  };
}
