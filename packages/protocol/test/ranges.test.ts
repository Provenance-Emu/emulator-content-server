import assert from 'node:assert/strict';
import test from 'node:test';
import { parseContentRange } from '../src/ranges.js';

test('upload ranges must end before the declared total', () => {
  for (const header of ['bytes 0-0/0', 'bytes 0-1/1', 'bytes 4-5/4']) {
    assert.equal(parseContentRange(header), null, header);
  }
});

test('upload ranges preserve valid known and unknown totals', () => {
  assert.deepEqual(parseContentRange('bytes 0-0/1'), { start: 0, end: 0, total: 1 });
  assert.deepEqual(parseContentRange('bytes 4-5/10'), { start: 4, end: 5, total: 10 });
  assert.deepEqual(parseContentRange('bytes 4-5/*'), { start: 4, end: 5, total: null });
});
