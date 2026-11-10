import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { workflowFixture } from './workflow-fixture.js';

test('investigators can submit local proposals for owner review without inheriting owner or worker access', async (t) => {
  const f = await workflowFixture({ count: 2 });
  t.after(() => f.dispose());
  const prefix = '/api/v1/investigator';
  const admin = '/api/v1/investigators';
  const issued = await f.app.inject({
    method: 'POST',
    url: admin,
    headers: f.auth,
    payload: {
      libraryIds: [f.library.id],
      operations: ['inspect', 'cleanup', 'suggest', 'diagnostics'],
      ttlSeconds: 600,
    },
  });
  assert.equal(issued.statusCode, 201, issued.body);
  const { credential, token } = issued.json();
  const headers = { authorization: `Bearer ${token}` };
  const get = (path: string) => f.app.inject({ url: `${prefix}${path}`, headers });
  const post = (path: string, payload: object) =>
    f.app.inject({ method: 'POST', url: `${prefix}${path}`, headers, payload });
  assert.equal(
    (await f.app.inject({ url: `${prefix}/libraries`, headers: f.auth })).statusCode,
    401,
  );
  assert.equal(
    (await f.app.inject({ url: `${prefix}/libraries`, headers: f.workerHeaders })).statusCode,
    401,
  );
  const foreign = f.catalog.createLibrary(f.owner.id, 'Private shelf');
  assert.equal((await get(`/libraries/${foreign.id}/sources`)).statusCode, 404);
  const first = await get(`/libraries/${f.library.id}/sources?limit=1`);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().items.length, 1);
  const second = await get(
    `/libraries/${f.library.id}/sources?limit=1&cursor=${first.json().nextCursor}`,
  );
  assert.equal(second.json().items.length, 1);
  assert.notEqual(second.json().items[0].id, first.json().items[0].id);
  assert.equal(second.json().nextCursor, null);
  assert.equal(first.body.includes(f.path), false);
  assert.equal((await get(`/runs/${f.run.id}`)).statusCode, 404);
  f.catalog.workflowRuns.cancelRun(f.run.id, f.owner.id);
  const input = { libraryId: f.library.id, sourceIds: [f.source.id] };
  assert.equal((await post('/runs', { ...input, online: true })).statusCode, 400);
  const started = await post('/runs', input);
  assert.equal(started.statusCode, 201, started.body);
  const runId = started.json().run.id;
  assert.equal(started.json().run.state, 'running');
  const inspection = await post(`/runs/${runId}/sources/${f.source.id}/inspect`, {});
  assert.equal(inspection.statusCode, 200, inspection.body);
  const candidate = inspection
    .json()
    .candidates.find((c: { kind: string }) => c.kind === 'metadata');
  assert.ok(candidate);
  const observation = {
    sourceId: f.source.id,
    kind: 'suspected-mismatch',
    reason: 'Review the local sidecar.',
    candidateIds: [candidate.id],
    evidenceIds: candidate.evidenceIds,
  };
  assert.equal(
    (
      await post(`/runs/${runId}/suggestions`, {
        ...observation,
        evidenceIds: ['forged'],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await post(`/runs/${runId}/suggestions`, {
        ...observation,
        kind: 'missing-front-artwork',
      })
    ).statusCode,
    400,
  );
  assert.deepEqual((await get(`/runs/${runId}/findings`)).json().items, []);
  const suggestion = await post(`/runs/${runId}/suggestions`, observation);
  assert.equal(suggestion.statusCode, 200, suggestion.body);
  const proposals = await f.app.inject({
    url: `/api/v1/workflow-runs/${runId}/proposals`,
    headers: f.auth,
  });
  assert.equal(proposals.json().items[0].id, suggestion.json().proposals[0].id);
  for (const url of [
    `/api/v1/workflow-runs/${runId}/approvals`,
    '/api/v1/workflow-approvals/example/apply',
    '/api/v1/workflow-workers/claim',
    '/api/v1/plugins/install',
    admin,
  ]) {
    const result = await f.app.inject({ method: 'POST', url, headers, payload: {} });
    assert.equal(result.statusCode, 401, url);
  }
  const diagnostics = await get('/diagnostics');
  assert.equal(diagnostics.statusCode, 200, diagnostics.body);
  for (const privateText of [f.base, 'Cleanup host', 'packages', 'token', 'error']) {
    assert.equal(diagnostics.body.includes(privateText), false, privateText);
  }
  const agentProposals = await get(`/runs/${runId}/proposals?limit=1`);
  assert.equal(agentProposals.json().items[0].id, proposals.json().items[0].id);
  assert.equal(agentProposals.body.includes('snapshotJson'), false);
  assert.equal(
    (await f.app.inject({ method: 'DELETE', url: `${admin}/${credential.id}`, headers: f.auth }))
      .statusCode,
    204,
  );
  assert.equal((await get('/libraries')).statusCode, 401);
  assert.equal(f.catalog.workflowRuns.getRun(runId)?.state, 'cancelled');
});

test('investigator reads recheck current library and expiry', async (t) => {
  const f = await workflowFixture();
  t.after(() => f.dispose());
  f.catalog.workflowRuns.cancelRun(f.run.id, f.owner.id);
  const issue = async (operations: string[]) => {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/v1/investigators',
      headers: f.auth,
      payload: { libraryIds: [f.library.id], operations, ttlSeconds: 600 },
    });
    assert.equal(response.statusCode, 201, response.body);
    return { authorization: `Bearer ${response.json().token}` };
  };
  const inspect = await issue(['inspect']);
  const cleanup = await issue(['cleanup', 'suggest', 'inspect']);
  const post = (url: string, headers: Record<string, string>, payload: object) =>
    f.app.inject({ method: 'POST', url: `/api/v1/investigator${url}`, headers, payload });
  const input = { libraryId: f.library.id, sourceIds: [f.source.id] };
  assert.equal((await post('/runs', inspect, input)).statusCode, 403);
  const started = await post('/runs', cleanup, input);
  assert.equal(started.statusCode, 201, started.body);
  const run = started.json().run.id;
  const foreign = f.catalog.createLibrary(f.owner.id, 'Other');
  const db = new DatabaseSync(join(f.base, 'data', 'library.sqlite'));
  try {
    db.prepare('UPDATE content_roots SET library_id=? WHERE id=?').run(foreign.id, f.root.id);
  } finally {
    db.close();
  }
  const lookup = await post(`/runs/${run}/sources/${f.source.id}/inspect`, cleanup, {});
  assert.equal(lookup.statusCode, 404);
  const cancelled = await post(`/runs/${run}/cancel`, cleanup, {});
  assert.equal(cancelled.json().run.state, 'cancelled');
  const original = Date.now;
  Date.now = () => original() + 601_000;
  try {
    assert.equal(
      (await f.app.inject({ url: '/api/v1/investigator/libraries', headers: cleanup })).statusCode,
      401,
    );
  } finally {
    Date.now = original;
  }
});
