import assert from 'node:assert/strict';
import test from 'node:test';
import { clearSession, createSessionStore, loadSession, saveSession } from '../src/lib/session.js';

export class MemoryStorage implements Storage {
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
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const expiresAt = '2099-01-01T00:00:00Z';

test('legacy compatibility rejects malformed token values instead of restoring credentials', () => {
  const previous = globalThis.localStorage;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    storage.setItem('ecs.session', JSON.stringify({ token: { invalid: true }, expiresAt }));
    assert.equal(loadSession(), null);
    assert.equal(storage.getItem('ecs.session'), null);
    saveSession({ token: 'generated-test-session', expiresAt });
    assert.equal(loadSession()?.expiresAt, expiresAt);
    clearSession();
    assert.equal(loadSession(), null);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: previous, configurable: true });
  }
});

test('scoped credentials isolate origins and namespaces and normalize the server origin', () => {
  const storage = new MemoryStorage();
  const first = createSessionStore('https://ONE.test:443/path', {
    storage,
    browserOrigin: 'https://one.test',
  });
  const same = createSessionStore('https://one.test', { storage });
  const second = createSessionStore('https://two.test', { storage });
  const desktop = createSessionStore('https://one.test', { storage, namespace: 'ecs.desktop' });
  first.save({ token: 'generated-test-session', expiresAt });
  assert.equal(same.load()?.expiresAt, expiresAt);
  assert.equal(second.load(), null);
  assert.equal(desktop.load(), null);
  second.clear();
  assert.equal(first.load()?.expiresAt, expiresAt);
  first.clear();
  assert.equal(same.load(), null);
});

test('legacy browser credentials migrate only into the current browser origin', () => {
  const storage = new MemoryStorage();
  storage.setItem('ecs.session', JSON.stringify({ token: 'generated-test-session', expiresAt }));
  const remote = createSessionStore('https://remote.test', {
    storage,
    browserOrigin: 'https://browser.test',
  });
  assert.equal(remote.load(), null);
  assert.ok(storage.getItem('ecs.session'));
  const current = createSessionStore('https://browser.test', {
    storage,
    browserOrigin: 'https://browser.test',
  });
  assert.equal(current.load()?.expiresAt, expiresAt);
  assert.equal(storage.getItem('ecs.session'), null);
  assert.equal(remote.load(), null);
});

test('an existing scoped login wins over legacy credentials and malformed or expired values are removed', () => {
  const storage = new MemoryStorage();
  const current = createSessionStore('https://browser.test', {
    storage,
    browserOrigin: 'https://browser.test',
  });
  current.save({ token: 'generated-current-session', expiresAt });
  storage.setItem('ecs.session', JSON.stringify({ token: 'generated-legacy-session', expiresAt }));
  assert.equal(current.load()?.token, 'generated-current-session');
  assert.equal(storage.getItem('ecs.session'), null);
  current.clear();
  for (const value of [
    '{',
    '[]',
    JSON.stringify({ token: 'expired', expiresAt: '2000-01-01T00:00:00Z' }),
    JSON.stringify({ token: 12, expiresAt }),
  ]) {
    storage.setItem('ecs.session', value);
    assert.equal(current.load(), null);
    assert.equal(storage.getItem('ecs.session'), null);
  }
});

test('browser compatibility wrappers use scoped storage and cannot restore a legacy token after sign-out', () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'window', {
    value: { location: { origin: 'https://browser.test' } },
    configurable: true,
  });
  try {
    storage.setItem(
      'ecs.session',
      JSON.stringify({ token: 'generated-legacy-session', expiresAt }),
    );
    assert.equal(loadSession()?.token, 'generated-legacy-session');
    assert.equal(storage.getItem('ecs.session'), null);
    saveSession({ token: 'generated-current-session', expiresAt });
    const scoped = createSessionStore('https://browser.test', { storage });
    assert.equal(scoped.load()?.token, 'generated-current-session');
    clearSession();
    assert.equal(scoped.load(), null);
    assert.equal(loadSession(), null);
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
