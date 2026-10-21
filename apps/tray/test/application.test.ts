import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import { createApplication } from '../../web/src/lib/application.js';
import { AccessDesk } from '../src/lib/access.js';
import { createDesktopContext, createDesktopSelection } from '../src/lib/application.js';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}
const session = { token: 'generated-server-a-session', expiresAt: '2099-01-01T00:00:00Z' };
const profile = (origin: string) => ({ origin, label: origin, profileKey: 'manual' });
const scheduler = { setTimeout: () => 0, clearTimeout() {} };
function fixture() {
  const storage = new MemoryStorage();
  const events = new EventTarget();
  const opened: string[] = [];
  const dependencies = {
    storage,
    events,
    openExternal: (url: string) => {
      opened.push(url);
    },
  };
  return { storage, events, opened, dependencies };
}

test('desktop sessions canonicalize origins, isolate browser/legacy tokens and validate endpoints', () => {
  const f = fixture();
  f.storage.setItem('ecs.tray.session', JSON.stringify(session));
  f.storage.setItem('ecs.session', JSON.stringify(session));
  f.storage.setItem('ecs.session:https%3A%2F%2Fa.test', JSON.stringify(session));
  const a = createDesktopContext(profile('https://A.test:443/'), f.dependencies);
  assert.equal(a.origin, 'https://a.test');
  assert.equal(a.sessions.load(), null);
  assert.equal(f.storage.getItem('ecs.tray.session'), null);
  a.sessions.save(session);
  assert.equal(
    createDesktopContext(profile('https://a.test'), f.dependencies).sessions.load()?.token,
    session.token,
  );
  assert.equal(
    createDesktopContext(profile('https://b.test'), f.dependencies).sessions.load(),
    null,
  );
  a.sessions.clear();
  assert.ok(f.storage.getItem('ecs.session'));
  for (const origin of [
    'file:///tmp/a',
    'javascript:alert(1)',
    'tauri://localhost',
    'https://user:password@a.test',
    'https://a.test/path',
    'https://a.test/?token=x',
    'bad',
  ]) {
    assert.throws(() => createDesktopContext(profile(origin), f.dependencies), /server address/i);
  }
});

test('player URLs resolve at the selected server and never allow external credentials or other routes', () => {
  const f = fixture();
  const context = createDesktopContext(profile('https://a.test'), f.dependencies);
  context.sessions.save(session);
  context.openPlayer('/play/?item=one&asset=two');
  assert.deepEqual(f.opened, ['https://a.test/play/?item=one&asset=two']);
  for (const href of [
    'https://evil.test/play/',
    '//evil.test/play/',
    '/ui/',
    '/play/?token=secret',
    '/play/?source=one&authorization=secret',
  ]) {
    assert.throws(() => context.openPlayer(href));
  }
});

test('switching contexts clears the old client before B requests; late A results stay inert', async () => {
  const f = fixture();
  const previous = globalThis.fetch;
  const requests: { origin: string; token: string | null }[] = [];
  let resolveA!: (value: Response) => void;
  const heldA = new Promise<Response>((resolve) => {
    resolveA = resolve;
  });
  const selection = createDesktopSelection(f.dependencies);
  selection.select(profile('https://a.test'));
  const a = get(selection);
  assert.ok(a);
  a.sessions.save(session);
  const appA = createApplication(a, scheduler);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ origin: url.origin, token: new Headers(init?.headers).get('authorization') });
    if (url.origin === 'https://a.test' && url.pathname === '/api/v1/capabilities') return heldA;
    if (url.pathname === '/health') return Response.json({ status: 'ok' });
    return Response.json(
      { status: 401, code: 'unauthorized', title: 'Unauthorized' },
      { status: 401 },
    );
  };
  const startingA = appA.start();
  selection.select(profile('https://b.test'));
  const b = get(selection);
  assert.ok(b);
  const appB = createApplication(b, scheduler);
  try {
    await appB.start();
    const health = a.client.health();
    resolveA(Response.json({ bootstrapped: true }));
    await health;
    assert.equal(requests.at(-1)?.token, null);
  } finally {
    resolveA(Response.json({ bootstrapped: true }));
  }
  try {
    await startingA;
    assert.equal(await appA.adoptSession(session, 0), false);
    assert.deepEqual(get(appB).libraries, []);
    assert.ok(
      requests
        .filter((request) => request.origin === 'https://b.test')
        .every((request) => request.token === null),
    );
    assert.equal(b.sessions.load(), null);
  } finally {
    appA.dispose();
    appB.dispose();
    selection.dispose();
    globalThis.fetch = previous;
  }
});

test('two windows follow explicit profile changes and session sign-out; disposal unsubscribes', async () => {
  const f = fixture();
  const first = createDesktopSelection(f.dependencies);
  const second = createDesktopSelection(f.dependencies);
  first.select(profile('https://a.test'));
  assert.equal(get(second)?.origin, 'https://a.test');
  const a = get(first);
  assert.ok(a);
  const other = get(second);
  assert.ok(other);
  const previous = globalThis.fetch;
  const tokens: (string | null)[] = [];
  globalThis.fetch = async (_input, init) => {
    tokens.push(new Headers(init?.headers).get('authorization'));
    return Response.json({ items: [], changes: [], nextCursor: '0', bootstrapped: true });
  };
  a.sessions.save(session);
  const app = createApplication(other, scheduler);
  try {
    await app.start();
    assert.equal(get(app).hasSession, true);
    a.sessions.clear();
    assert.equal(get(app).hasSession, false);
    await other.client.health();
    assert.equal(tokens.at(-1), null);
    second.dispose();
    first.select(profile('https://b.test'));
    assert.equal(get(second)?.origin, 'https://a.test');
  } finally {
    app.dispose();
    first.dispose();
    second.dispose();
    globalThis.fetch = previous;
  }
});

test('status sign-out clears both windows immediately while revocation is pending', async () => {
  const f = fixture();
  const previous = globalThis.fetch;
  const a = createDesktopContext(profile('https://a.test'), f.dependencies);
  const b = createDesktopContext(profile('https://a.test'), f.dependencies);
  a.sessions.save(session);
  const desk = new AccessDesk(a);
  const app = createApplication(b, scheduler);
  let revoke!: (value: Response) => void;
  const revocation = new Promise<Response>((resolve) => {
    revoke = resolve;
  });
  const tokens: (string | null)[] = [];
  globalThis.fetch = async (input, init) => {
    tokens.push(new Headers(init?.headers).get('authorization'));
    if (String(input).endsWith('/auth/logout')) return revocation;
    return Response.json({
      items: [],
      changes: [],
      nextCursor: '0',
      bootstrapped: true,
      manages: false,
    });
  };
  try {
    await app.start();
    const signOut = desk.signOut();
    assert.equal(get(desk).session, null);
    assert.equal(get(app).hasSession, false);
    assert.equal(a.sessions.load(), null);
    await a.client.health();
    assert.equal(tokens.at(-1), null);
    revoke(Response.json({}));
    await signOut;
  } finally {
    revoke(Response.json({}));
    desk.dispose();
    app.dispose();
    globalThis.fetch = previous;
  }
});

test('a status login finishing after profile replacement cannot restore A into either window', async () => {
  const f = fixture();
  const selection = createDesktopSelection(f.dependencies);
  selection.select(profile('https://a.test'));
  const a = get(selection);
  assert.ok(a);
  const desk = new AccessDesk(a);
  const previous = globalThis.fetch;
  let release!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const tokens: (string | null)[] = [];
  globalThis.fetch = async (input, init) => {
    tokens.push(new Headers(init?.headers).get('authorization'));
    if (String(input).endsWith('/auth/login')) return pending;
    return Response.json({ status: 'ok' });
  };
  try {
    const login = desk.signIn('generated-owner', 'generated-password');
    selection.select(profile('https://b.test'));
    desk.dispose();
    release(Response.json({ ...session, user: { id: 'owner', username: 'owner', isOwner: true } }));
    assert.equal(await login, false);
    assert.equal(a.sessions.load(), null);
    assert.equal(get(selection)?.sessions.load(), null);
    await a.client.health();
    assert.equal(tokens.at(-1), null);
    assert.equal(get(desk).session, null);
  } finally {
    release(Response.json(session));
    desk.dispose();
    selection.dispose();
    globalThis.fetch = previous;
  }
});
