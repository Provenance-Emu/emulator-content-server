import assert from 'node:assert/strict';
import test from 'node:test';
import { importSummary, previewSummary, signInToken } from '../src/lib/icloud.js';

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
