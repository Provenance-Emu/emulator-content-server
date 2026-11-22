import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

const KEY = 'local-owner.key';
type Server = Awaited<ReturnType<typeof openServer>>;
// Windows offers no key: a file mode cannot keep it private there.
const skip = process.platform === 'win32';
/** A server that has reached the point where `ecs serve` writes the key. */
async function serving(options: Parameters<typeof openServer>[0]): Promise<Server> {
  const server = await openServer(options);
  await server.offerLocalOwnerSignIn();
  return server;
}

async function bootstrap(server: Server): Promise<string> {
  const token = issueToken();
  server.catalog.saveBootstrapHash(token.hash);
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: token.token, username: 'owner', password: 'correct-horse' },
  });
  assert.equal(created.statusCode, 201);
  return (created.json() as { userId: string }).userId;
}
const exchange = (server: Server, key: unknown, remoteAddress?: string) =>
  server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/local',
    payload: { key },
    ...(remoteAddress ? { remoteAddress } : {}),
  });
const features = async (server: Server) =>
  (
    (await server.app.inject({ method: 'GET', url: '/api/v1/capabilities' })).json() as {
      features: { localOwnerSignIn?: boolean };
    }
  ).features;

test('the key in the data folder signs the owner in from this computer only', {
  skip,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-local-owner-'));
  const server = await serving({ dataDir: dir, loginLimit: 50 });
  try {
    const key = (await readFile(join(dir, KEY), 'utf8')).trim();
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await stat(join(dir, KEY))).mode & 0o777, 0o600);
    assert.equal((await features(server)).localOwnerSignIn, true);

    // Nothing is handed out before an owner account exists.
    assert.equal((await exchange(server, key)).statusCode, 409);
    const ownerId = await bootstrap(server);

    // This computer is already trusted for the library, but server updates want a real session.
    const updates = (token?: string) =>
      server.app.inject({
        method: 'GET',
        url: '/api/v1/server/updates',
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      });
    assert.equal((await updates()).statusCode, 403);

    const wrong = await exchange(server, issueToken().token);
    assert.equal(wrong.statusCode, 401);
    assert.equal((await exchange(server, '')).statusCode >= 400, true);
    assert.equal((await exchange(server, 42)).statusCode >= 400, true);

    // The right key from another device is refused: reading the file is not enough off this computer.
    for (const address of ['192.168.1.20', '8.8.8.8', '::ffff:10.0.0.4']) {
      assert.equal((await exchange(server, key, address)).statusCode, 403);
    }

    const signedIn = await exchange(server, key);
    assert.equal(signedIn.statusCode, 200);
    assert.equal(signedIn.headers['cache-control'], 'no-store');
    const session = signedIn.json() as { token: string; tokenType: string; userId: string };
    assert.equal(session.tokenType, 'Bearer');
    assert.equal(session.userId, ownerId);
    assert.notEqual(session.token, key);

    // It is an ordinary owner session, so the update screen opens.
    assert.equal((await updates(session.token)).statusCode, 200);
    const read = await server.app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: { authorization: `Bearer ${session.token}` },
      remoteAddress: '8.8.8.8',
    });
    assert.equal(read.statusCode, 200);
    const events = (read.json() as { events: { action: string; detail?: unknown }[] }).events;
    assert.ok(events.some((event) => event.action === 'local-sign-in'));
    assert.ok(events.some((event) => event.action === 'local-sign-in-failed'));
    // Neither the key nor the session reaches the audit log.
    assert.equal(read.body.includes(key), false);
    assert.equal(read.body.includes(session.token), false);

    assert.equal((await exchange(server, key, '::1')).statusCode, 200);

    // "Token" mode trusts no address. The key is not address trust, so it still works here,
    // and it is the only way in from this computer without a password.
    server.catalog.setAccessPolicy({ mode: 'token', subnets: [], actorId: ownerId });
    assert.equal(
      (await server.app.inject({ method: 'GET', url: '/api/v1/libraries' })).statusCode,
      401,
    );
    assert.equal((await exchange(server, key)).statusCode, 200);
    assert.equal((await exchange(server, key, '192.168.1.20')).statusCode, 403);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('each start writes a new key, and a clean stop removes it', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-local-owner-'));
  try {
    const first = await serving({ dataDir: dir });
    await bootstrap(first);
    const old = (await readFile(join(dir, KEY), 'utf8')).trim();
    await first.close();
    await assert.rejects(stat(join(dir, KEY)));

    // A leftover file, or a link someone planted, is replaced and never written through.
    const elsewhere = join(dir, 'elsewhere.txt');
    await writeFile(elsewhere, 'untouched');
    await symlink(elsewhere, join(dir, KEY));

    const second = await serving({ dataDir: dir });
    try {
      const fresh = (await readFile(join(dir, KEY), 'utf8')).trim();
      assert.notEqual(fresh, old);
      assert.equal(await readFile(elsewhere, 'utf8'), 'untouched');
      assert.equal((await exchange(second, old)).statusCode, 401);
      assert.equal((await exchange(second, fresh)).statusCode, 200);

      // A file that is no longer this run's key is left for whoever wrote it.
      await writeFile(join(dir, KEY), 'someone-else');
    } finally {
      await second.close();
    }
    assert.equal(await readFile(join(dir, KEY), 'utf8'), 'someone-else');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no key exists before the server is listening, and never for a public server', async () => {
  for (const open of [
    (dataDir: string) => openServer({ dataDir }),
    (dataDir: string) => serving({ dataDir, localTrust: false }),
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'ecs-local-owner-'));
    const server = await open(dir);
    try {
      await bootstrap(server);
      await assert.rejects(stat(join(dir, KEY)));
      assert.equal((await features(server)).localOwnerSignIn, false);
      assert.equal((await exchange(server, issueToken().token)).statusCode, 409);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('offering it twice keeps the one key', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-local-owner-'));
  const server = await serving({ dataDir: dir });
  try {
    const key = await readFile(join(dir, KEY), 'utf8');
    assert.equal(await server.offerLocalOwnerSignIn(), true);
    assert.equal(await readFile(join(dir, KEY), 'utf8'), key);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('guessing the key is rate limited', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-local-owner-'));
  const server = await serving({ dataDir: dir, loginLimit: 3 });
  try {
    await bootstrap(server);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++)
      statuses.push((await exchange(server, issueToken().token)).statusCode);
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    // The real key does not get around the limit either.
    const key = (await readFile(join(dir, KEY), 'utf8')).trim();
    assert.equal((await exchange(server, key)).statusCode, 429);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
