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
    const invitations = '/invitations';
    assert.equal((await post(invitations, {})).statusCode, 401);
    const createdInvite = await post(invitations, {}, true);
    assert.equal(createdInvite.statusCode, 201);
    assert.equal(createdInvite.headers['cache-control'], 'no-store');
    const invite = createdInvite.json();
    assert.match(invite.pin, /^\d{6}$/);
    assert.equal(invite.expiresInSeconds, 300);
    const claim = { id: invite.id, pin: invite.pin, name: 'iFly from web home' };
    assert.equal((await post(`${invitations}/redeem`, { ...claim, id: 'other' })).statusCode, 404);
    const claims = await Promise.all([
      post(`${invitations}/redeem`, claim),
      post(`${invitations}/redeem`, claim),
    ]);
    assert.deepEqual(claims.map((reply) => reply.statusCode).sort(), [200, 404]);
    assert.deepEqual(claims.find((reply) => reply.statusCode === 200)?.json().scopes, ['read']);
    const withdrawn = (await post(invitations, {}, true)).json();
    assert.equal(
      (
        await server.app.inject({
          method: 'DELETE',
          url: `/api/v1/device-pairing${invitations}/${withdrawn.id}`,
          headers,
        })
      ).statusCode,
      204,
    );
    assert.equal((await post(`${invitations}/redeem`, { ...claim, ...withdrawn })).statusCode, 404);

    const challenge = await post('', { name: 'Living Room TV' });
    assert.equal(challenge.statusCode, 201);
    assert.equal(challenge.headers['cache-control'], 'no-store');
    const { id, pin, secret, expiresInSeconds } = challenge.json();
    assert.match(pin, /^\d{6}$/);
    assert.equal(expiresInSeconds, 300);
    const requests = '/requests';
    const list = () => server.app.inject({ url: `/api/v1/device-pairing${requests}`, headers });
    const newcomer = await post(requests, { name: 'iFly' });
    assert.equal(newcomer.statusCode, 201);
    const requested = newcomer.json();
    const proof = { id: requested.id, secret: requested.secret };
    assert.equal(requested.pin, undefined);
    assert.equal(
      (await server.app.inject({ url: `/api/v1/device-pairing${requests}` })).statusCode,
      401,
    );
    assert.deepEqual(
      (await list())
        .json()
        .items.map(({ name, approved }: { name: string; approved: boolean }) => ({
          name,
          approved,
        })),
      [{ name: 'iFly', approved: false }],
    );
    assert.equal((await post(`${requests}/${proof.id}/approve`, {})).statusCode, 401);
    assert.equal((await post('/redeem', proof)).statusCode, 404);
    assert.equal((await post(`${requests}/complete`, { ...proof, pin })).statusCode, 202);
    const ownerCode = await post(`${requests}/${proof.id}/approve`, {}, true);
    assert.equal(ownerCode.statusCode, 200);
    const newPin: string = ownerCode.json().pin;
    assert.match(newPin, /^\d{6}$/);
    assert.deepEqual((await post(`${requests}/status`, proof)).json(), { approved: true });
    assert.equal((await post('/inspect', { pin: newPin }, true)).statusCode, 404);
    assert.equal(
      (await post(`${requests}/complete`, { ...proof, secret: 'wrong', pin: newPin })).statusCode,
      404,
    );
    assert.equal((await post(`${requests}/complete`, { ...proof, pin })).statusCode, 400);
    const completed = await Promise.all([
      post(`${requests}/complete`, { ...proof, pin: newPin }),
      post(`${requests}/complete`, { ...proof, pin: newPin }),
    ]);
    assert.deepEqual(completed.map((reply) => reply.statusCode).sort(), [200, 404]);
    assert.deepEqual(completed.find((reply) => reply.statusCode === 200)?.json().scopes, ['read']);
    assert.deepEqual((await list()).json().items, []);
    const canceled = (await post(requests, { name: 'iCube' })).json();
    assert.equal((await post(`${requests}/cancel`, canceled)).statusCode, 204);
    assert.equal((await post(`${requests}/status`, canceled)).statusCode, 404);
    const denied = (await post(requests, { name: 'Provenance' })).json();
    const validPIN = (await post(`${requests}/${denied.id}/approve`, {}, true)).json().pin;
    const badPIN = validPIN === '000000' ? '111111' : '000000';
    for (let remaining = 4; remaining >= 0; remaining--) {
      const response = await post(`${requests}/complete`, { ...denied, pin: badPIN });
      assert.equal(response.statusCode, remaining === 0 ? 404 : 400);
    }
    assert.equal(
      (await post(`${requests}/complete`, { ...denied, pin: validPIN })).statusCode,
      404,
    );
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
    const expiringRequest = (await post(requests, { name: 'Expiring handheld' })).json();
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      t.mock.timers.tick(300_001);
      assert.equal((await post('/inspect', { pin: expiring.pin }, true)).statusCode, 404);
      assert.equal(
        (await post('/redeem', { id: expiring.id, secret: expiring.secret })).statusCode,
        404,
      );
      assert.equal((await post(`${requests}/status`, expiringRequest)).statusCode, 404);
    } finally {
      t.mock.timers.reset();
    }
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
