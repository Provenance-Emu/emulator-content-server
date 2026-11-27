import assert from 'node:assert/strict';
import test from 'node:test';
import {
  importSummary,
  macReads,
  previewSummary,
  readerNote,
  signInFailure,
  signInToken,
} from '../src/lib/icloud.js';

test('a sign-in token is taken only from a message Apple sent', () => {
  const data = { ckWebAuthToken: 'generated-token' };
  assert.equal(signInToken('https://idmsa.apple.com', data), 'generated-token');
  assert.equal(signInToken('https://www.icloud.com', data), 'generated-token');
  assert.equal(signInToken('https://apple.com.example.org', data), null);
  assert.equal(signInToken('https://notapple.com', data), null);
  assert.equal(signInToken('http://idmsa.apple.com', data), null);
  assert.equal(signInToken('null', data), null);
  assert.equal(signInToken('https://idmsa.apple.com', { ckWebAuthToken: 7 }), null);
  assert.equal(signInToken('https://idmsa.apple.com', 'generated-token'), null);
});

test('the token is read the way Apple sends it', () => {
  // Apple's hand-back page is served from its CloudKit address and names the value ckSession.
  const origin = 'https://cdn.apple-cloudkit.com';
  assert.equal(signInToken(origin, { status: 0, ckSession: 'generated-token' }), 'generated-token');
  assert.equal(signInToken(origin, { ckWebAuthToken: 'generated-token' }), 'generated-token');
  assert.equal(signInToken('https://apple-cloudkit.com.example.org', { ckSession: 'x' }), null);
  assert.equal(signInToken(origin, { errorMessage: 'unknownError' }), null);
});

test('a failed sign-in is explained, and only when Apple says so', () => {
  const origin = 'https://cdn.apple-cloudkit.com';
  assert.match(signInFailure(origin, { errorMessage: 'accessError' }) ?? '', /on the Web/);
  assert.match(signInFailure(origin, { errorMessage: 'unknownError' }) ?? '', /could not finish/);
  assert.match(signInFailure(origin, { errorMessage: 'window closed' }) ?? '', /closed/);
  assert.match(signInFailure(origin, { errorMessage: 'something new' }) ?? '', /could not finish/);
  assert.equal(signInFailure(origin, { ckSession: 'generated-token' }), null);
  assert.equal(signInFailure('https://example.org', { errorMessage: 'accessError' }), null);
});

test('previews and results read as sentences', () => {
  const preview = {
    checkedAt: '2026-11-25T00:00:00Z',
    saves: 5,
    bytes: 100,
    games: 4,
    gamesHere: 1,
    ready: 2,
    alreadyHere: 0,
    unmatched: [],
  };
  assert.equal(
    previewSummary(preview),
    '5 saves for 4 games in iCloud. 1 game of those is in your library.',
  );
  assert.equal(previewSummary({ ...preview, saves: 0 }), 'No saves were found in iCloud.');
  const result = {
    state: 'completed' as const,
    total: 5,
    processed: 5,
    imported: 3,
    skipped: 1,
    failed: 1,
    startedAt: '2026-11-25T00:00:00Z',
    finishedAt: '2026-11-25T00:01:00Z',
    message: null,
  };
  assert.equal(
    importSummary(result),
    '3 saves brought in. 1 save could not be downloaded and will be tried next time.',
  );
  assert.equal(importSummary({ ...result, imported: 0, failed: 0 }), 'Nothing new to bring in.');
  assert.equal(
    importSummary({ ...result, state: 'running', processed: 2 }),
    'Copying saves: 2 of 5.',
  );
});

test('the Mac route is offered only when its reader can read iCloud now', () => {
  const reader = (
    state: 'absent' | 'ready' | 'signedOut' | 'restricted' | 'unavailable' | 'working',
  ) => ({ offered: true, state, lastSeenAt: null }) as const;
  assert.equal(macReads(undefined), false, 'an older server');
  assert.equal(macReads(reader('ready')), true);
  assert.equal(macReads(reader('working')), true);
  for (const state of ['absent', 'signedOut', 'restricted', 'unavailable'] as const)
    assert.equal(macReads(reader(state)), false, state);

  // A server that cannot have a reader says nothing about a Mac.
  assert.equal(readerNote(undefined), null);
  assert.equal(readerNote({ offered: false, state: 'absent', lastSeenAt: null }), null);
  assert.match(readerNote(reader('ready')) ?? '', /No Apple sign-in is needed/);
  assert.match(readerNote(reader('absent')) ?? '', /open Emulation Server there/);
  assert.match(readerNote(reader('signedOut')) ?? '', /not signed in to iCloud/);
  assert.match(readerNote(reader('restricted')) ?? '', /System Settings/);
});
