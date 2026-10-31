import assert from 'node:assert/strict';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { libraryFixture } from './library-fixture.js';

test('workflow enrollment is single-use, read-back is redacted and worker tokens are never owner sessions', async () => {
  const f = await libraryFixture();
  try {
    const provision = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-hosts',
      headers: f.auth,
      payload: { name: 'Generated host' },
    });
    assert.equal(provision.statusCode, 201);
    const { host, enrollmentToken } = provision.json();
    assert.equal(typeof enrollmentToken, 'string');
    const enrolled = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-workers/enroll',
      payload: { enrollmentToken },
    });
    assert.equal(enrolled.statusCode, 200);
    const token = enrolled.json().token;
    const second = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-workers/enroll',
      payload: { enrollmentToken },
    });
    assert.equal(second.statusCode, 401);
    assert.equal(second.body.includes(enrollmentToken), false);
    const listing = await f.app.inject({
      method: 'GET',
      url: '/api/v1/workflow-hosts',
      headers: f.auth,
    });
    assert.equal(listing.body.includes(token), false);
    assert.equal(listing.body.includes(enrollmentToken), false);
    for (const [method, url, payload] of [
      ['GET', '/api/v1/users', undefined],
      ['POST', '/api/v1/uploads', { libraryId: f.library.id }],
      ['PUT', '/api/v1/sources/source/matches/selections', {}],
      ['GET', '/dav/', undefined],
    ] as const) {
      const denied = await f.app.inject({
        method,
        url,
        payload,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.ok([401, 403, 404].includes(denied.statusCode));
    }
    const claim = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-workers/claim',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    assert.equal(claim.statusCode, 200);
    assert.equal(claim.json().lease ?? null, null);
    const revoked = await f.app.inject({
      method: 'DELETE',
      url: `/api/v1/workflow-hosts/${host.id}`,
      headers: f.auth,
    });
    assert.equal(revoked.statusCode, 204);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/workflow-workers/claim',
          headers: { authorization: `Bearer ${token}` },
          payload: {},
        })
      ).statusCode,
      401,
    );
  } finally {
    await f.dispose();
  }
});

test('expired enrollment and ordinary account sessions cannot provision hosts', async () => {
  const f = await libraryFixture();
  try {
    const enrollment = issueToken();
    f.catalog.workflowIdentities.createHost(f.owner.id, 'Expired', enrollment.hash, Date.now() - 1);
    const expired = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-workers/enroll',
      payload: { enrollmentToken: enrollment.token },
    });
    assert.equal(expired.statusCode, 401);
    const user = f.catalog.createUser({
      username: 'reader',
      passwordHash: 'generated-hash',
      actorId: f.owner.id,
    });
    const session = issueToken();
    f.catalog.createSession(user.id, session.hash);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/workflow-hosts',
          headers: { authorization: `Bearer ${session.token}` },
          payload: { name: 'Denied' },
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.dispose();
  }
});
