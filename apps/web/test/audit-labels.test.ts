import assert from 'node:assert/strict';
import test from 'node:test';
import { auditLabel, auditNeedsAttention } from '../src/lib/audit-labels.js';

test('the activity log speaks in sentences, and still shows an action it has no words for', () => {
  assert.equal(auditLabel('scan-content-root'), "Checked a folder's files");
  assert.equal(auditLabel('login'), 'Signed in');
  assert.equal(auditLabel('local-sign-in'), "Signed in from the server's own computer");
  // A new action reads as plain words until it is given a sentence.
  assert.equal(auditLabel('rotate-backup-key'), 'Rotate backup key');
  assert.equal(auditNeedsAttention('login-failed'), true);
  assert.equal(auditNeedsAttention('local-sign-in-failed'), true);
  assert.equal(auditNeedsAttention('login'), false);
});
