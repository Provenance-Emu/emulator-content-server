import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

// These describe macOS, where the gap exists: a listener on every address leaves 127.0.0.1 free
// for another program to take. On Linux the wildcard listener already excludes that, the extra
// bind is refused, and the server carries on without it, so there is nothing to hold or to test.
const skip = process.platform !== 'darwin';

/** Whether another listener can take 127.0.0.1 on `port`. */
function canTakeLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const other = createServer();
    other.once('error', () => resolve(false));
    other.listen(port, '127.0.0.1', () => other.close(() => resolve(true)));
  });
}

test('a server on the home network holds 127.0.0.1 itself and answers there', {
  skip,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-loopback-'));
  const server = await openServer({ dataDir: dir, loginLimit: 50 });
  try {
    await server.app.listen({ host: '0.0.0.0', port: 0 });
    const { port } = server.app.server.address() as AddressInfo;
    // Until it is held, anyone on this computer could take the loopback address.
    assert.equal(await canTakeLoopback(port), true);
    assert.equal(await server.holdLoopback(), true);
    assert.equal(await canTakeLoopback(port), false, 'nobody else can bind it now');
    assert.equal(await server.holdLoopback(), true, 'asking twice keeps the one listener');
    await server.offerLocalOwnerSignIn();

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);

    // The whole application answers there, and sees the caller as this computer.
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const made = await fetch(`http://127.0.0.1:${port}/api/v1/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: bootstrap.token,
        username: 'owner',
        password: 'correct-horse',
      }),
    });
    assert.equal(made.status, 201);
    const key = (await readFile(join(dir, 'local-owner.key'), 'utf8')).trim();
    const local = await fetch(`http://127.0.0.1:${port}/api/v1/auth/local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    assert.equal(local.status, 200);

    await server.close();
    assert.equal(await canTakeLoopback(port), true, 'released on close');
  } finally {
    await server.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('a loopback-only or public server holds nothing extra', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-loopback-'));
  const local = await openServer({ dataDir: join(dir, 'a') });
  const open = await openServer({ dataDir: join(dir, 'b'), localTrust: false });
  try {
    await local.app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal(await local.holdLoopback(), false);
    await open.app.listen({ host: '0.0.0.0', port: 0 });
    assert.equal(await open.holdLoopback(), false, 'no local trust, so nothing to protect');
    const { port } = open.app.server.address() as AddressInfo;
    assert.equal(await canTakeLoopback(port), true);
  } finally {
    await local.close();
    await open.close();
    await rm(dir, { recursive: true, force: true });
  }
});
