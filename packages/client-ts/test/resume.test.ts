import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretDownload, planResume } from '../src/client.js';

test('partial downloads resume with a range and restart when a server ignores it', () => {
  assert.deepEqual(planResume(0, 10), { offset: 0, range: null });
  assert.deepEqual(planResume(4, 10), { offset: 4, range: 'bytes=4-' });
  assert.equal(interpretDownload(206, 4), 'append');
  assert.equal(interpretDownload(200, 4), 'restart');
  assert.equal(interpretDownload(304, 4), 'not-modified');
  assert.equal(interpretDownload(416, 4), 'unsatisfiable');
});
