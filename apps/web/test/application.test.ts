import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import { createApplication } from '../src/lib/application.js';
import { deferred, library, serverFixture, session } from './lifecycle-fixture.js';

// Real ContentClient + controlled transport preserves login/token/HTTP-error behavior.
test('idempotent starts discover libraries and owner authority with one timer and no scans', async () => {
  const f = serverFixture();
  const app = createApplication(f.context, f.scheduler);
  try {
    await Promise.all([app.start(), app.start()]);
    assert.equal(get(app).signedIn, true);
    assert.equal(get(app).owner, true);
    assert.equal(get(app).settled, true);
    assert.equal(get(app).libraries[0]?.canCreateItems, false);
    assert.equal(get(app).capabilities?.bootstrapped, true);
    assert.equal(f.scheduler.pending, 1);
    assert.deepEqual(f.scheduler.delays, [15_000]);
    assert.equal(f.requests.filter(({ path }) => path === '/api/v1/changes').length, 1);
    assert.equal(
      f.requests.some(({ path }) => path.includes('scan') || path === '/api/v1/sources'),
      false,
    );
    assert.equal(JSON.stringify(get(app)).includes(session.token), false);
    app.dispose();
    assert.equal(f.scheduler.pending, 0);
  } finally {
    app.dispose();
    f.restore();
  }
});

test('owner-only roots 403 still permits signed-in browsing and retains creation flags', async () => {
  const f = serverFixture();
  f.ownerStatus = 403;
  f.libraries = [{ ...library(), canCreateItems: true }];
  const app = createApplication(f.context, f.scheduler);
  try {
    await app.start();
    assert.equal(get(app).signedIn, true);
    assert.equal(get(app).owner, false);
    assert.equal(get(app).failure, null);
    assert.equal(get(app).libraries[0]?.canCreateItems, true);
  } finally {
    app.dispose();
    f.restore();
  }
});

test('sign-out clears private state immediately even when revocation fails or restore is pending', async () => {
  const f = serverFixture();
  f.context.sessions.save(session);
  f.logoutStatus = 503;
  const pending = deferred<Response>();
  const requested = deferred<void>();
  f.discovery = () => {
    requested.resolve();
    return pending.promise;
  };
  const app = createApplication(f.context, f.scheduler);
  try {
    const start = app.start();
    await requested.promise;
    const logout = app.signOut();
    assert.equal(f.context.sessions.load(), null);
    assert.equal(get(app).signedIn, false);
    pending.resolve(Response.json({ items: [library()], nextCursor: null }));
    await Promise.all([start, logout]);
    assert.deepEqual(get(app).libraries, []);
    assert.equal(get(app).owner, false);
    assert.equal(get(app).hasSession, false);
  } finally {
    app.dispose();
    f.restore();
  }
});

test('disposal invalidates an outstanding restore and prevents later subscriber callbacks', async () => {
  const f = serverFixture();
  const pending = deferred<Response>();
  const requested = deferred<void>();
  f.discovery = () => {
    requested.resolve();
    return pending.promise;
  };
  const app = createApplication(f.context, f.scheduler);
  try {
    const start = app.start();
    await requested.promise;
    app.dispose();
    const snapshot = get(app);
    let notifications = 0;
    const unsubscribe = app.subscribe(() => {
      notifications++;
    });
    pending.resolve(Response.json({ items: [library()], nextCursor: null }));
    await start;
    await app.start();
    assert.deepEqual(get(app), snapshot);
    assert.equal(notifications, 1);
    assert.equal(f.scheduler.pending, 0);
    unsubscribe();
  } finally {
    app.dispose();
    f.restore();
  }
});

test('authenticated cadence removes revoked scopes and refreshes unchanged scopes without changefeed events', async () => {
  const f = serverFixture();
  f.libraries = [library('kept'), library('revoked')];
  const app = createApplication(f.context, f.scheduler);
  try {
    await app.start();
    const first = get(app).invalidation;
    f.libraries = [library('kept')];
    f.ownerStatus = 403;
    await f.scheduler.tick();
    assert.deepEqual(
      get(app).libraries.map(({ id }) => id),
      ['kept'],
    );
    assert.equal(get(app).owner, false);
    assert.ok(get(app).invalidation > first);
    const second = get(app).invalidation;
    await f.scheduler.tick();
    assert.ok(
      get(app).invalidation > second,
      'item-only ACL changes still refresh the visible page',
    );
    assert.equal(f.scheduler.pending, 1);
  } finally {
    app.dispose();
    f.restore();
  }
});

test('transient discovery errors preserve the current library scope and do not start overlapping polls', async () => {
  const f = serverFixture();
  const app = createApplication(f.context, f.scheduler);
  try {
    await app.start();
    const initial = get(app);
    const pending = deferred<Response>();
    f.discovery = () => pending.promise;
    const tick = f.scheduler.tick();
    assert.equal(f.scheduler.pending, 0);
    pending.resolve(Response.json({}, { status: 503 }));
    await tick;
    assert.deepEqual(get(app).libraries, initial.libraries);
    assert.equal(get(app).signedIn, true);
    assert.equal(get(app).invalidation, initial.invalidation);
    assert.ok(get(app).failure);
    assert.equal(f.scheduler.pending, 1);
  } finally {
    app.dispose();
    f.restore();
  }
});

test('periodic 401 clears session, owner authority and private results even when public capabilities work', async () => {
  const f = serverFixture();
  f.context.sessions.save(session);
  const app = createApplication(f.context, f.scheduler);
  try {
    await app.start();
    const generation = get(app).invalidation;
    f.discoveryStatus = 401;
    await f.scheduler.tick();
    assert.equal(get(app).signedIn, false);
    assert.equal(get(app).owner, false);
    assert.equal(get(app).hasSession, false);
    assert.deepEqual(get(app).libraries, []);
    assert.equal(f.context.sessions.load(), null);
    assert.ok(get(app).invalidation > generation);
    assert.equal(get(app).reachable, true);
  } finally {
    app.dispose();
    f.restore();
  }
});

test('revoked stored credentials fall back to existing passwordless network access', async () => {
  const f = serverFixture();
  f.context.sessions.save(session);
  f.discovery = async () =>
    Response.json(
      { items: [library()], nextCursor: null },
      {
        status: f.requests.at(-1)?.token ? 401 : 200,
      },
    );
  const app = createApplication(f.context, f.scheduler);
  try {
    await app.start();
    assert.equal(get(app).signedIn, true);
    assert.equal(get(app).hasSession, false);
    assert.equal(f.context.sessions.load(), null);
    assert.equal(get(app).libraries[0]?.id, 'library');
  } finally {
    app.dispose();
    f.restore();
  }
});

test('post-login adoption stores credentials once and rejects late callbacks after sign-out', async () => {
  const f = serverFixture();
  const app = createApplication(f.context, f.scheduler);
  try {
    await app.start();
    const epoch = get(app).authEpoch;
    assert.equal(await app.adoptSession(session, epoch), true);
    assert.equal(get(app).hasSession, true);
    assert.equal(JSON.stringify(get(app)).includes(session.token), false);
    assert.equal(f.context.sessions.load()?.expiresAt, '2099-01-01T00:00:00Z');
    assert.equal(f.scheduler.pending, 1);
    await app.signOut();
    // ContentClient.login/bootstrap installs its token before Login calls onsignin.
    f.context.client.setToken(session.token);
    assert.equal(await app.adoptSession(session, epoch), false);
    await f.context.client.browseLibraries();
    assert.equal(f.requests.at(-1)?.token, null);
    assert.equal(get(app).hasSession, false);
    assert.deepEqual(get(app).libraries, []);
  } finally {
    app.dispose();
    f.restore();
  }
});

test('context replacement at the same origin rejects old login callbacks', async () => {
  const f = serverFixture();
  const old = createApplication(f.context, f.scheduler);
  try {
    await old.start();
    const epoch = get(old).authEpoch;
    old.dispose();
    const next = createApplication({ ...f.context, key: 'server-epoch-2' }, f.scheduler);
    try {
      await next.start();
      await next.adoptSession(
        { ...session, token: 'generated-next-context-session' },
        get(next).authEpoch,
      );
      const snapshot = get(next);
      assert.equal(await old.adoptSession(session, epoch), false);
      assert.deepEqual(get(next), snapshot);
      assert.equal(f.context.sessions.load()?.token, 'generated-next-context-session');
      await f.context.client.browseLibraries();
      assert.equal(f.requests.at(-1)?.token, 'Bearer generated-next-context-session');
      assert.equal(get(next).contextKey, 'server-epoch-2');
      assert.equal(f.scheduler.pending, 1);
    } finally {
      next.dispose();
    }
  } finally {
    old.dispose();
    f.restore();
  }
});

test('a changefeed 401 clears private state while the application keeps its public status cadence', async () => {
  const f = serverFixture();
  f.context.sessions.save(session);
  const app = createApplication(f.context, f.scheduler);
  try {
    await app.start();
    f.changes = async () => Response.json({}, { status: 401 });
    await f.scheduler.tick();
    assert.equal(get(app).signedIn, false);
    assert.deepEqual(get(app).libraries, []);
    assert.equal(f.context.sessions.load(), null);
    assert.equal(f.scheduler.pending, 1);
    const discoveryCalls = f.requests.filter(
      ({ path }) => path === '/api/v1/browse-libraries',
    ).length;
    await f.scheduler.tick();
    assert.equal(get(app).reachable, true);
    assert.equal(
      f.requests.filter(({ path }) => path === '/api/v1/browse-libraries').length,
      discoveryCalls,
    );
  } finally {
    app.dispose();
    f.restore();
  }
});

test('a late periodic 401 cannot clear a newer accepted login or duplicate its timer', async () => {
  const f = serverFixture();
  const app = createApplication(f.context, f.scheduler);
  try {
    await app.start();
    const pending = deferred<Response>();
    const requested = deferred<void>();
    f.discovery = () => {
      requested.resolve();
      return pending.promise;
    };
    const refresh = f.scheduler.tick();
    await requested.promise;
    await app.signOut();
    f.discovery = null;
    const newer = { ...session, token: 'generated-newer-session' };
    assert.equal(await app.adoptSession(newer, get(app).authEpoch), true);
    const snapshot = get(app);
    pending.resolve(Response.json({}, { status: 401 }));
    await refresh;
    assert.deepEqual(get(app), snapshot);
    assert.equal(f.context.sessions.load()?.token, 'generated-newer-session');
    assert.equal(f.scheduler.pending, 1);
    await f.context.client.browseLibraries();
    assert.equal(f.requests.at(-1)?.token, 'Bearer generated-newer-session');
  } finally {
    app.dispose();
    f.restore();
  }
});

test('late HTTP logout completion preserves the credential of a newer accepted login', async () => {
  const f = serverFixture();
  f.context.sessions.save(session);
  const app = createApplication(f.context, f.scheduler);
  try {
    await app.start();
    const oldEpoch = get(app).authEpoch;
    const pending = deferred<Response>();
    f.logout = () => pending.promise;
    const logout = app.signOut();
    const newer = { ...session, token: 'generated-newer-session' };
    assert.equal(await app.adoptSession(newer, get(app).authEpoch), true);
    pending.resolve(Response.json({}));
    await logout;
    await f.context.client.browseLibraries();
    assert.equal(f.requests.at(-1)?.token, 'Bearer generated-newer-session');
    assert.equal(get(app).signedIn, true);
    assert.equal(f.context.sessions.load()?.token, 'generated-newer-session');
    // A second, late Login callback must restore this accepted token too.
    f.context.client.setToken(session.token);
    assert.equal(await app.adoptSession(session, oldEpoch), false);
    await f.context.client.browseLibraries();
    assert.equal(f.requests.at(-1)?.token, 'Bearer generated-newer-session');
    assert.equal(f.scheduler.pending, 1);
  } finally {
    app.dispose();
    f.restore();
  }
});

test('initial transient discovery failure retries stored credentials on the next application cadence', async () => {
  const f = serverFixture();
  f.context.sessions.save(session);
  f.discoveryStatus = 503;
  const app = createApplication(f.context, f.scheduler);
  try {
    await app.start();
    assert.equal(get(app).settled, true);
    assert.equal(get(app).signedIn, false);
    assert.equal(get(app).hasSession, true);
    f.discoveryStatus = 200;
    await f.scheduler.tick();
    assert.equal(get(app).signedIn, true);
    assert.equal(get(app).libraries[0]?.id, 'library');
    assert.equal(f.requests.at(-1)?.token, 'Bearer generated-test-session');
    assert.equal(f.scheduler.pending, 1);
  } finally {
    app.dispose();
    f.restore();
  }
});
