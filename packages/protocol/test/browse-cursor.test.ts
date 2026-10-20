import assert from 'node:assert/strict';
import test from 'node:test';
import * as protocol from '../src/index.js';

test('browse cursors bind version, query and actor without storing long names', () => {
  const api = protocol as unknown as {
    encodeBrowseCursor(f: string, p: { entityType: string; id: string }): string;
    decodeBrowseCursor(c: string, f: string): unknown;
  };
  assert.equal(typeof api.encodeBrowseCursor, 'function');
  const p = { entityType: 'item', id: 'original-id' };
  const cursor = api.encodeBrowseCursor('query-actor-hash', p);
  assert.deepEqual(api.decodeBrowseCursor(cursor, 'query-actor-hash'), p);
  for (const bad of [
    '?',
    'a'.repeat(4097),
    Buffer.from(
      JSON.stringify({ version: 2, fingerprint: 'query-actor-hash', position: p }),
    ).toString('base64url'),
  ])
    assert.equal(api.decodeBrowseCursor(bad, 'query-actor-hash'), null);
  assert.equal(api.decodeBrowseCursor(cursor, 'different-actor'), null);
});

test('malformed browse cursor positions cannot reach database parameter binding', () => {
  const api = protocol as unknown as { decodeBrowseCursor(c: string, f: string): unknown };
  for (const position of [
    { entityType: ['item'], id: 'i' },
    { entityType: 'item', id: 1 },
    { entityType: 'item', id: '' },
    { entityType: 'item', id: 'unsafe\0id' },
    { entityType: 'unknown', id: 'i' },
  ]) {
    const cursor = Buffer.from(
      JSON.stringify({ version: 1, fingerprint: 'query', position }),
    ).toString('base64url');
    assert.equal(api.decodeBrowseCursor(cursor, 'query'), null);
  }
});
