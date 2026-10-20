import assert from 'node:assert/strict';
import { ContentClient, type Library } from '@ecs/client';
import type { ServerContext } from '../src/lib/application.js';
import type { PollScheduler } from '../src/lib/change-watch.js';
import type { StoredSession } from '../src/lib/session.js';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A clock that runs the production timer callback, including its async work. */
export class ManualScheduler implements PollScheduler {
  private tasks = new Map<number, () => void | Promise<void>>();
  private next = 0;
  delays: number[] = [];
  get pending() {
    return this.tasks.size;
  }
  setTimeout(task: () => void | Promise<void>, milliseconds: number): unknown {
    this.delays.push(milliseconds);
    const id = ++this.next;
    this.tasks.set(id, task);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }
  async tick() {
    const entry = this.tasks.entries().next().value;
    assert.ok(entry, 'expected a scheduled poll');
    this.tasks.delete(entry[0]);
    await entry[1]();
  }
}

export const library = (id = 'library'): Library => ({
  id,
  name: `Library ${id}`,
  ownerId: 'owner',
  revision: 1,
  createdAt: '2026-10-20T00:00:00Z',
  canCreateItems: false,
});
export const session: StoredSession = {
  token: 'generated-test-session',
  expiresAt: '2099-01-01T00:00:00Z',
};

export function sessionStore(initial: StoredSession | null = null) {
  let value = initial;
  return {
    load: () => value,
    save: (stored: StoredSession) => {
      value = stored;
    },
    clear: () => {
      value = null;
    },
  };
}

export function serverFixture() {
  const previous = globalThis.fetch;
  const requests: { path: string; token: string | null }[] = [];
  let libraries = [library()];
  let ownerStatus = 200;
  let discoveryStatus = 200;
  let logoutStatus = 200;
  let logout: (() => Promise<Response>) | null = null;
  let discovery: (() => Promise<Response>) | null = null;
  let roots: (() => Promise<Response>) | null = null;
  let changes: ((cursor: string) => Promise<Response>) | null = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, token: new Headers(init?.headers).get('authorization') });
    switch (url.pathname) {
      case '/api/v1/capabilities':
        return Response.json({
          protocol: { major: 1, minor: 0, path: '/api/v1' },
          minClientVersion: '1',
          features: {
            rangeRequests: true,
            multiRange: false,
            resumableUploads: true,
            changeFeed: true,
            guestGrants: true,
            virtualFormats: [],
            webdav: false,
            natTraversal: false,
          },
          limits: { maxUploadBytes: 1048576, maxPageSize: 100 },
          authentication: ['token'],
          bootstrapped: true,
        });
      case '/api/v1/roots':
        return roots ? roots() : Response.json({ items: [] }, { status: ownerStatus });
      case '/api/v1/browse-libraries':
        return discovery
          ? discovery()
          : Response.json({ items: libraries, nextCursor: null }, { status: discoveryStatus });
      case '/api/v1/changes':
        return changes
          ? changes(url.searchParams.get('cursor') ?? '0')
          : Response.json({ changes: [], nextCursor: url.searchParams.get('cursor') ?? '0' });
      case '/api/v1/auth/logout':
        return logout ? logout() : Response.json({}, { status: logoutStatus });
      default:
        throw new Error(`Unexpected request: ${url.pathname}`);
    }
  };
  const scheduler = new ManualScheduler();
  const sessions = sessionStore();
  const client = new ContentClient('http://server.test');
  const context: ServerContext = {
    key: 'server-epoch-1',
    origin: 'http://server.test',
    label: 'Test server',
    client,
    sessions,
    openPlayer() {},
  };
  return {
    context,
    scheduler,
    requests,
    set libraries(value: Library[]) {
      libraries = value;
    },
    set ownerStatus(value: number) {
      ownerStatus = value;
    },
    set discoveryStatus(value: number) {
      discoveryStatus = value;
    },
    set logout(value: (() => Promise<Response>) | null) {
      logout = value;
    },
    set logoutStatus(value: number) {
      logoutStatus = value;
    },
    set discovery(value: (() => Promise<Response>) | null) {
      discovery = value;
    },
    set roots(value: (() => Promise<Response>) | null) {
      roots = value;
    },
    set changes(value: ((cursor: string) => Promise<Response>) | null) {
      changes = value;
    },
    restore() {
      globalThis.fetch = previous;
    },
  };
}
