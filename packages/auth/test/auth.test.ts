import assert from 'node:assert/strict';
import test from 'node:test';
import type { UserActor } from '@ecs/domain';
import { authorize } from '../src/acl.js';
import { assertListenPolicy } from '../src/listen-policy.js';
import { hashPassword, verifyPassword } from '../src/passwords.js';
import { RateLimiter } from '../src/rate-limit.js';
import { redactSecrets } from '../src/redact.js';
import { hashToken, issueToken } from '../src/tokens.js';

const owner: UserActor = {
  kind: 'user',
  userId: 'user-1',
  username: 'owner',
  isOwner: false,
  tokenKind: 'session',
  scopes: ['read', 'write', 'admin'],
};

test('argon2id passwords verify and reject the wrong secret', () => {
  const encoded = hashPassword('correct-horse');
  assert.match(encoded, /^\$argon2id\$/);
  assert.equal(verifyPassword('correct-horse', encoded), true);
  assert.equal(verifyPassword('wrong-secret', encoded), false);
});

test('bearer tokens are stored only as hashes', () => {
  const issued = issueToken();
  assert.notEqual(issued.token, issued.hash);
  assert.equal(hashToken(issued.token), issued.hash);
});

test('library roles and guest grants are additive and restricted', () => {
  assert.equal(
    authorize({ actor: owner, action: 'write', libraryId: 'lib', membership: 'editor' }),
    true,
  );
  assert.equal(
    authorize({ actor: owner, action: 'admin', libraryId: 'lib', membership: 'editor' }),
    false,
  );
  assert.equal(
    authorize({
      actor: { ...owner, scopes: ['read'] },
      action: 'write',
      libraryId: 'lib',
      membership: 'owner',
    }),
    false,
  );
  assert.equal(
    authorize({
      actor: owner,
      action: 'read',
      libraryId: 'lib',
      itemId: 'item',
      membership: null,
      itemPermissions: ['read'],
    }),
    true,
  );
  assert.equal(
    authorize({
      actor: {
        kind: 'guest',
        grantId: 'grant',
        libraryId: 'lib',
        itemId: null,
        capabilities: ['read'],
      },
      action: 'read',
      libraryId: 'lib',
      itemId: 'item',
      assetKind: 'bios',
      shareable: false,
    }),
    false,
  );
  assert.equal(
    authorize({
      actor: {
        kind: 'guest',
        grantId: 'grant',
        libraryId: 'lib',
        itemId: null,
        capabilities: ['read', 'share_restricted'],
      },
      action: 'read',
      libraryId: 'lib',
      itemId: 'item',
      assetKind: 'bios',
      shareable: false,
    }),
    true,
  );
});

test('listen policy keeps unconfigured servers on loopback unless explicitly widened', () => {
  assert.doesNotThrow(() =>
    assertListenPolicy({
      host: '127.0.0.1',
      bootstrapped: false,
      allowUnconfiguredLan: false,
      publicInternet: false,
      tlsTerminated: false,
    }),
  );
  assert.throws(() =>
    assertListenPolicy({
      host: '0.0.0.0',
      bootstrapped: false,
      allowUnconfiguredLan: false,
      publicInternet: false,
      tlsTerminated: false,
    }),
  );
  assert.throws(() =>
    assertListenPolicy({
      host: '0.0.0.0',
      bootstrapped: true,
      allowUnconfiguredLan: true,
      publicInternet: true,
      tlsTerminated: false,
    }),
  );
});

test('rate limits and log redaction', () => {
  const limiter = new RateLimiter(2, 1_000);
  assert.equal(limiter.allow('login', 0), true);
  assert.equal(limiter.allow('login', 10), true);
  assert.equal(limiter.allow('login', 20), false);
  assert.match(redactSecrets('Authorization Bearer abc.def token'), /Bearer \[redacted\]/);
});
