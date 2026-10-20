import assert from 'node:assert/strict';
import test from 'node:test';
import { davFixture } from './dav-fixture.js';

test('a socket request ceiling limits invalid bearer attempts before authentication', async () => {
  const f = await davFixture();
  try {
    for (let i = 0; i < 6000; i++) {
      const response = await f.server.app.inject({
        url: '/api/v1/libraries',
        headers: { authorization: 'Bearer invalid', 'x-forwarded-for': `192.0.2.${i % 255}` },
        remoteAddress: '192.0.2.1',
      });
      assert.equal(response.statusCode, 401);
    }
    const blocked = await f.server.app.inject({
      url: '/api/v1/libraries',
      headers: { authorization: 'Bearer invalid', 'x-forwarded-for': '198.51.100.1' },
      remoteAddress: '192.0.2.1',
    });
    assert.equal(blocked.statusCode, 429);
    assert.ok(blocked.headers['retry-after']);
    assert.equal(
      (
        await f.server.app.inject({
          url: '/api/v1/libraries',
          headers: f.headers,
          remoteAddress: '192.0.2.2',
        })
      ).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});
