import type { Capabilities, ContentClient, Library } from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import {
  type ChangeWatch,
  createChangeWatch,
  defaultPollScheduler,
  type PollScheduler,
} from './change-watch.js';
import { explain, isForbidden, isUnauthorized } from './problems.js';
import type { SessionStore, StoredSession } from './session.js';

export type { SessionStore } from './session.js';

export interface ServerContext {
  key: string;
  origin: string;
  label: string;
  client: ContentClient;
  sessions: SessionStore;
  openPlayer(relativeHref: string): void;
}

export interface ApplicationState {
  contextKey: string;
  /** Capture when rendering Login; adoption rejects callbacks from an older authentication lifetime. */
  authEpoch: number;
  capabilities: Capabilities | null;
  reachable: boolean | null;
  settled: boolean;
  signedIn: boolean;
  hasSession: boolean;
  owner: boolean;
  libraries: Library[];
  failure: string | null;
  /** Refresh the visible bounded page; clear it first if its scope is no longer accessible. */
  invalidation: number;
}

export interface ApplicationController extends Readable<ApplicationState> {
  start(): Promise<void>;
  signOut(): Promise<void>;
  dispose(): void;
  adoptSession(session: StoredSession, expectedEpoch: number): Promise<boolean>;
}

/** A context/client is owned by one controller. Dispose it before replacing the context epoch. */
export function createApplication(
  context: ServerContext,
  scheduler: PollScheduler = defaultPollScheduler,
): ApplicationController {
  const contextKey = context.key;
  let current: ApplicationState = {
    contextKey,
    authEpoch: 0,
    capabilities: null,
    reachable: null,
    settled: false,
    signedIn: false,
    hasSession: false,
    owner: false,
    libraries: [],
    failure: null,
    invalidation: 0,
  };
  const store = writable(current);
  let epoch = 0;
  let disposed = false;
  let started: Promise<void> | null = null;
  let timer: { handle: unknown } | null = null;
  let watcher: ChangeWatch | null = null;
  let acceptedToken: string | undefined;
  let feedChanged = false;
  let needsAuthentication = true;

  const live = (run: number) => !disposed && context.key === contextKey && run === epoch;
  function update(patch: Partial<ApplicationState>) {
    current = { ...current, ...patch };
    store.set(current);
  }
  function clearTimer() {
    if (timer) scheduler.clearTimeout(timer.handle);
    timer = null;
  }
  function stopWatch() {
    watcher?.dispose();
    watcher = null;
    feedChanged = false;
  }
  function forget() {
    epoch++;
    needsAuthentication = false;
    stopWatch();
    acceptedToken = undefined;
    context.sessions.clear();
    context.client.setToken(undefined);
    update({
      authEpoch: epoch,
      signedIn: false,
      hasSession: false,
      owner: false,
      libraries: [],
      settled: true,
      failure: null,
      invalidation: current.invalidation + 1,
    });
  }
  function schedule(run: number) {
    if (!live(run) || timer) return;
    timer = {
      handle: scheduler.setTimeout(async () => {
        timer = null;
        await cycle(run);
      }, 15_000),
    };
  }
  async function publicStatus(run: number) {
    try {
      const capabilities = await context.client.capabilities();
      if (live(run)) update({ capabilities, reachable: true });
    } catch (error) {
      if (live(run)) update({ reachable: false, failure: explain(error) });
    }
  }
  async function discover(run: number): Promise<'ok' | 'error' | 'unauthorized' | 'stale'> {
    // Auth changes clear current.owner; only this epoch's confirmed authority survives a transient check.
    let owner = current.owner;
    let failure: string | null = null;
    try {
      await context.client.roots();
      if (!live(run)) return 'stale';
      owner = true;
    } catch (error) {
      if (!live(run)) return 'stale';
      if (isUnauthorized(error)) return 'unauthorized';
      if (isForbidden(error)) owner = false;
      else failure = explain(error);
    }
    try {
      const listing = await context.client.browseLibraries();
      if (!live(run)) return 'stale';
      update({ signedIn: true, owner, libraries: listing.items, failure });
      return 'ok';
    } catch (error) {
      if (!live(run)) return 'stale';
      if (isUnauthorized(error)) return 'unauthorized';
      if (isForbidden(error)) {
        update({ signedIn: true, owner, libraries: [], failure: null });
        return 'ok';
      }
      update({ owner, failure: explain(error) });
      return 'error';
    }
  }
  async function watch(run: number) {
    if (!live(run) || !current.signedIn) return;
    if (watcher) {
      await watcher.poll();
    } else {
      watcher = createChangeWatch(context.client, {
        scheduler: null,
        invalidate() {
          if (live(run)) feedChanged = true;
        },
        unauthorized() {
          if (live(run)) {
            forget();
            schedule(epoch);
          }
        },
      });
      await watcher.start();
    }
  }
  async function cycle(run: number) {
    try {
      await publicStatus(run);
      if (!live(run)) return;
      if (needsAuthentication || current.signedIn) {
        let result = await discover(run);
        if (!live(run)) return;
        if (result === 'unauthorized') {
          const retryWithoutToken = needsAuthentication && acceptedToken !== undefined;
          forget();
          run = epoch;
          if (retryWithoutToken) {
            needsAuthentication = true;
            result = await discover(run);
          } else result = 'unauthorized';
          if (!live(run)) return;
        }
        if (result === 'ok') needsAuthentication = false;
        await watch(run);
        if (!live(run)) return;
        if (result === 'ok' || feedChanged) {
          feedChanged = false;
          update({ invalidation: current.invalidation + 1 });
        }
      }
      if (live(run)) update({ settled: true });
    } finally {
      schedule(run);
    }
  }
  return {
    subscribe: store.subscribe,
    start() {
      if (disposed || context.key !== contextKey) return Promise.resolve();
      if (!started) {
        const stored = context.sessions.load();
        acceptedToken = stored?.token;
        context.client.setToken(acceptedToken);
        update({ hasSession: !!stored });
        started = cycle(epoch);
      }
      return started;
    },
    async signOut() {
      if (disposed || context.key !== contextKey) return;
      // Start revocation while the old token is still installed, then clear locally immediately.
      const revocation = context.client.logout().catch(() => undefined);
      clearTimer();
      forget();
      schedule(epoch);
      await revocation;
      // ContentClient.logout clears its token on success, possibly after a new login completed.
      if (!disposed && context.key === contextKey) context.client.setToken(acceptedToken);
    },
    async adoptSession(session, expectedEpoch) {
      if (!live(expectedEpoch)) {
        // A disposed context is inert. While live, undo Login's pre-callback token mutation.
        if (!disposed && context.key === contextKey) context.client.setToken(acceptedToken);
        return false;
      }
      clearTimer();
      stopWatch();
      epoch++;
      const run = epoch;
      needsAuthentication = true;
      acceptedToken = session.token;
      context.sessions.save({ token: session.token, expiresAt: session.expiresAt });
      context.client.setToken(acceptedToken);
      update({
        authEpoch: run,
        hasSession: true,
        signedIn: false,
        owner: false,
        libraries: [],
        failure: null,
        invalidation: current.invalidation + 1,
      });
      await cycle(run);
      return live(run) && current.signedIn;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch++;
      clearTimer();
      stopWatch();
      acceptedToken = undefined;
      update({
        authEpoch: epoch,
        signedIn: false,
        owner: false,
        libraries: [],
        hasSession: false,
        invalidation: current.invalidation + 1,
      });
    },
  };
}
