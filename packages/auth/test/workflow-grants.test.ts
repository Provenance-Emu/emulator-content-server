import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowGrantAllows } from '../src/workflow-grants.js';

test('workflow host grants never authorize owner actions or another assigned host', () => {
  const principal = { kind: 'workflow-host' as const, hostId: 'host-a', ownerId: 'owner' };
  assert.equal(workflowGrantAllows(principal, 'claim'), true);
  assert.equal(workflowGrantAllows(principal, 'publish', { hostId: 'host-a' }), true);
  assert.equal(workflowGrantAllows(principal, 'publish', { hostId: 'host-b' }), false);
  for (const action of ['approve', 'apply', 'users', 'install', 'credentials'])
    assert.equal(workflowGrantAllows(principal, action, { hostId: 'host-a' }), false);
  assert.equal(workflowGrantAllows(principal, 'publish'), false);
});
