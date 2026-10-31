import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentClient } from '../src/client.js';

test('workflow client uses escaped IDs and the same run methods for owner and worker callers', async (t) => {
  const calls: { url: URL; method: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({ run: { id: 'run/id' }, lease: null, items: [], nextCursor: null });
  };
  const client = new ContentClient('https://example.test', 'generated-not-a-real-token');
  await client.workflowRun('run/id');
  await client.cancelWorkflowRun('run/id');
  await client.claimWorkflowRun();
  assert.equal(calls[0]?.url.pathname, '/api/v1/workflow-runs/run%2Fid');
  assert.equal(calls[1]?.url.pathname, '/api/v1/workflow-runs/run%2Fid/cancel');
  assert.equal(calls[1]?.method, 'POST');
  assert.equal(calls[2]?.url.pathname, '/api/v1/workflow-workers/claim');
  assert.deepEqual(calls[2]?.body, {});
});

test('cleanup approval client binds exact versions and preserves the application ID across retries', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls: { url: URL; body: unknown; key: string | null }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: new URL(String(input)),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      key: new Headers(init?.headers).get('idempotency-key'),
    });
    return Response.json({
      approval: { id: 'approval/id' },
      applications: [],
      application: { status: 'undone' },
    });
  };
  const client = new ContentClient('https://example.test', 'generated-not-a-real-token');
  const versions = [{ id: 'proposal/id', version: 2, digest: 'a'.repeat(64) }];
  await client.approveWorkflowBatch('run/id', 7, versions, 'approval-request-1');
  await client.applyWorkflowApproval('approval/id', 'application-1');
  await client.applyWorkflowApproval('approval/id', 'application-1');
  await client.undoWorkflowApplication('application-1', 'source/id');
  assert.equal(calls[0]?.url.pathname, '/api/v1/workflow-runs/run%2Fid/approvals');
  assert.equal(calls[0]?.key, 'approval-request-1');
  assert.deepEqual(calls[0]?.body, { runRevision: 7, proposals: versions });
  assert.deepEqual(calls[1]?.body, calls[2]?.body);
  assert.deepEqual(calls[1]?.body, { applicationId: 'application-1' });
  assert.equal(
    calls[3]?.url.pathname,
    '/api/v1/workflow-applications/application-1/sources/source%2Fid/undo',
  );
});
