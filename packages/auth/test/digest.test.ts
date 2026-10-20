import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DAV_REALM, DigestAuthority, digestVerifiers, responseDigest } from '../src/digest.js';

function fields(value: string): Record<string, string> {
  return Object.fromEntries(
    [...value.matchAll(/(\w+)=(?:"([^"]*)"|([^, ]+))/g)].map((m) => [m[1], m[2] ?? m[3] ?? '']),
  );
}
function fixture() {
  let now = 1_700_000_000_000;
  const authority = new DigestAuthority({ now: () => now, key: Buffer.alloc(32, 7) });
  const username = 'test-user';
  const password = 'generated-test-password';
  const verifier = { id: 'credential', ...digestVerifiers(username, password) };
  const lookup = (name: string) => (name === username ? verifier : null);
  let challenge = fields(authority.challenges()[0] ?? '');
  function header(algorithm = 'SHA-256', count = 1, cnonce = 'client', secret = password) {
    const hash = (value: string) =>
      createHash(algorithm === 'MD5' ? 'md5' : 'sha256')
        .update(value)
        .digest('hex');
    const nc = count.toString(16).padStart(8, '0');
    const uri = '/dav/libraries/?x=%C3%BC';
    const response = hash(
      `${hash(`${username}:${DAV_REALM}:${secret}`)}:${challenge.nonce}:${nc}:${cnonce}:auth:${hash(`PROPFIND:${uri}`)}`,
    );
    return `Digest username="${username}", realm="${DAV_REALM}", nonce="${challenge.nonce}", uri="${uri}", algorithm=${algorithm}, response="${response}", qop=auth, nc=${nc}, cnonce="${cnonce}", opaque="${challenge.opaque}"`;
  }
  const verify = (headerValue: string, method = 'PROPFIND', uri = '/dav/libraries/?x=%C3%BC') =>
    authority.verify({ header: headerValue, method, uri }, lookup);
  return {
    authority,
    header,
    verify,
    lookup,
    refresh: () => {
      challenge = fields(authority.challenges()[0] ?? '');
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('Digest response matches RFC 7616 MD5 example', () => {
  assert.equal(
    responseDigest(
      'MD5',
      '939e7578ed9e3c518a452acee763bce9',
      'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      '00000001',
      '0a4f113b',
      'GET',
      '/dir/index.html',
    ),
    '6629fae49393a05397450978507c4ef1',
  );
});
test('both Digest algorithms authenticate and bind the exact method and URI', () => {
  for (const algorithm of ['SHA-256', 'MD5']) {
    const f = fixture();
    assert.equal(f.verify(f.header(algorithm), 'GET').kind, 'invalid');
    assert.equal(f.verify(f.header(algorithm), 'PROPFIND', '/dav/libraries/').kind, 'invalid');
    assert.deepEqual(f.verify(f.header(algorithm)), { kind: 'ok', credentialId: 'credential' });
  }
});
test('out-of-order counts work, duplicates and old counts cannot replay', () => {
  const f = fixture();
  assert.equal(f.verify(f.header('SHA-256', 2)).kind, 'ok');
  assert.equal(f.verify(f.header('SHA-256', 1)).kind, 'ok');
  assert.equal(f.verify(f.header('SHA-256', 1)).kind, 'invalid');
  assert.equal(f.verify(f.header('SHA-256', 65)).kind, 'ok');
  assert.equal(f.verify(f.header('SHA-256', 1)).kind, 'invalid');
  assert.equal(f.verify(f.header('SHA-256', 64)).kind, 'ok');
});
test('malformed headers and wrong credentials never consume valid counts', () => {
  const f = fixture();
  const good = f.header();
  for (const bad of [
    good.replace('qop=auth', 'qop=auth-int'),
    `${good}, nc=00000001`,
    good.replace('nc=00000001', 'nc=00000000'),
    good.replace('nc=00000001', 'nc=1'),
    good.replace('algorithm=SHA-256', 'algorithm=SHA-512'),
    good.replace('realm="Emulator', 'realm="Other'),
    good.replace('response="', 'response="z'),
    good.replace('cnonce="client"', 'cnonce=""'),
    good.replace('username="test-user"', 'username="unknown"'),
    `${good} ${'x'.repeat(8192)}`,
    good.replace('opaque="', 'opaque="bad'),
    good.replace('nonce="', 'nonce="bad'),
    good.replace(', cnonce="client"', ''),
    good.replace(', qop=auth', ''),
    'Digest x="unterminated',
  ]) {
    assert.equal(f.verify(bad).kind, 'invalid');
  }
  assert.equal(f.verify(f.header('SHA-256', 1, 'client', 'wrong')).kind, 'invalid');
  assert.equal(f.verify(good).kind, 'ok');
});
test('expired valid nonce is stale; invalid password and process key remain invalid', () => {
  const f = fixture();
  f.advance(300_001);
  assert.equal(f.verify(f.header('SHA-256', 1, 'client', 'wrong')).kind, 'invalid');
  assert.equal(f.verify(f.header()).kind, 'stale');
  const other = new DigestAuthority({ key: Buffer.alloc(32, 8) });
  assert.equal(
    other.verify(
      { header: f.header(), method: 'PROPFIND', uri: '/dav/libraries/?x=%C3%BC' },
      f.lookup,
    ).kind,
    'invalid',
  );
});
test('replay capacity fails closed and expired contexts release capacity', () => {
  const f = fixture();
  for (let i = 0; i < 10_000; i++)
    assert.equal(f.verify(f.header('SHA-256', 1, `c${i}`)).kind, 'ok');
  assert.equal(f.verify(f.header('SHA-256', 1, 'overflow')).kind, 'full');
  assert.equal(f.verify(f.header('SHA-256', 1, 'c0')).kind, 'invalid');
  assert.equal(f.verify(f.header('SHA-256', 2, 'c0')).kind, 'ok');
  f.advance(300_001);
  // A fresh challenge after expiry permits a new context on the same authority.
  f.refresh();
  assert.equal(f.verify(f.header('SHA-256', 1, 'after-expiry')).kind, 'ok');
  assert.match(f.authority.challenges(true)[0] ?? '', /stale=true/);
});
