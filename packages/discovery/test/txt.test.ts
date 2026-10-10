import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicTxt, buildDiscoveryTxt } from '../src/txt.js';

test('discovery records expose only public server coordinates', () => {
  const txt = buildDiscoveryTxt({
    serverId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Living Room',
    tls: false,
    pairing: true,
  });
  assertPublicTxt(txt);
  assert.equal(txt.v, '1');
  assert.equal(txt.pair, '1');
  assert.throws(() => assertPublicTxt({ ...txt, token: 'secret' }));
});
