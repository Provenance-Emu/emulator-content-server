import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

test('pairing requires owner approval and a private one-use device secret', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ecs-pairing-api-'));
  const server = await openServer({ dataDir, localTrust: false, uiDir: dataDir });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const owner = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'generated-password' },
    });
    assert.equal(owner.statusCode, 201);
    const headers = { authorization: `Bearer ${owner.json().token}` };
    const post = (path: string, payload: object, authorized = false) =>
      server.app.inject({
        method: 'POST',
        url: `/api/v1/device-pairing${path}`,
        payload,
        headers: authorized ? headers : {},
      });
    const challenge = await post('', { name: 'Living Room TV' });
    assert.equal(challenge.statusCode, 201);
    assert.equal(challenge.headers['cache-control'], 'no-store');
    const { id, pin, secret, expiresInSeconds } = challenge.json();
    assert.match(pin, /^\d{6}$/);
    assert.equal(expiresInSeconds, 300);
    assert.equal((await post('/inspect', { pin })).statusCode, 401);
    assert.equal((await post('/approve', { id, pin })).statusCode, 401);
    assert.equal((await post('/redeem', { id, secret })).statusCode, 202);
    assert.equal((await post('/redeem', { id, secret: pin })).statusCode, 404);
    const inspect = await post('/inspect', { pin }, true);
    assert.deepEqual(inspect.json(), { id, name: 'Living Room TV' });
    assert.equal((await post('/approve', { id: 'other', pin }, true)).statusCode, 404);
    assert.equal((await post('/approve', { id, pin }, true)).statusCode, 200);
    assert.equal((await post('/redeem', { id, secret: pin })).statusCode, 404);

    const redemptions = await Promise.all([
      post('/redeem', { id, secret }),
      post('/redeem', { id, secret }),
    ]);
    assert.deepEqual(redemptions.map((reply) => reply.statusCode).sort(), [200, 404]);
    const issued = redemptions.find((reply) => reply.statusCode === 200)?.json();
    assert.deepEqual(issued.scopes, ['read']);
    const device = { authorization: `Bearer ${issued.token}` };
    assert.equal(
      (await server.app.inject({ url: '/api/v1/browse-libraries', headers: device })).statusCode,
      200,
    );
    assert.equal(
      (await server.app.inject({ url: '/api/v1/device-tokens', headers: device })).statusCode,
      403,
    );
    assert.equal(
      (
        await server.app.inject({
          method: 'DELETE',
          url: `/api/v1/device-tokens/${issued.id}`,
          headers,
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (await server.app.inject({ url: '/api/v1/browse-libraries', headers: device })).statusCode,
      401,
    );
    const expiring = (await post('', { name: 'Expiring TV' })).json();
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      t.mock.timers.tick(300_001);
      assert.equal((await post('/inspect', { pin: expiring.pin }, true)).statusCode, 404);
      assert.equal(
        (await post('/redeem', { id: expiring.id, secret: expiring.secret })).statusCode,
        404,
      );
    } finally {
      t.mock.timers.reset();
    }
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
