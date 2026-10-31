import assert from 'node:assert/strict';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { libraryFixture } from './library-fixture.js';

test('only an assigned host can report private-state recovery; stale leases cannot keep working', async () => {
  const f = await libraryFixture();
  try {
    const enrollment = issueToken(),
      worker = issueToken();
    const host = f.catalog.workflowIdentities.createHost(
      f.owner.id,
      'Recovery host',
      enrollment.hash,
      Date.now() + 600_000,
    );
    f.catalog.workflowIdentities.enrollHost(enrollment.hash, worker.hash);
    const run = f.catalog.workflowRuns.createRun(
      {
        workflowId: 'org.ecs.library-cleanup',
        workflowDigest: 'b'.repeat(64),
        hostId: host.id,
        scope: { libraryId: f.library.id },
        options: { online: false, checksum: false, shareImages: false },
      },
      f.owner.id,
    );
    const lease = f.catalog.workflowRuns.claimRun(host.id);
    assert.ok(lease);
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-workers/interrupt',
      headers: { authorization: `Bearer ${worker.token}` },
      payload: { lease, recoveryRequired: true },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().run.state, 'recovery-required');
    const stale = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-workers/heartbeat',
      headers: { authorization: `Bearer ${worker.token}` },
      payload: { lease },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(f.catalog.workflowRuns.getRun(run.id)?.error?.includes(worker.token), false);
  } finally {
    await f.close();
  }
});

test('cleanup run API queues read-only work, fences publications and rejects foreign host work', async () => {
  const f = await libraryFixture();
  try {
    const enroll = issueToken(),
      worker = issueToken();
    const host = f.catalog.workflowIdentities.createHost(
      f.owner.id,
      'Worker',
      enroll.hash,
      Date.now() + 600_000,
    );
    f.catalog.workflowIdentities.enrollHost(enroll.hash, worker.hash);
    const otherEnroll = issueToken(),
      otherWorker = issueToken();
    f.catalog.workflowIdentities.createHost(
      f.owner.id,
      'Other',
      otherEnroll.hash,
      Date.now() + 600_000,
    );
    f.catalog.workflowIdentities.enrollHost(otherEnroll.hash, otherWorker.hash);
    const draft = {
      workflowId: 'org.ecs.library-cleanup',
      workflowDigest: 'b'.repeat(64),
      hostId: host.id,
      scope: { libraryId: f.library.id },
      options: { online: false, checksum: false, shareImages: false },
    };
    const create = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-runs',
      headers: { ...f.auth, 'idempotency-key': 'generated-workflow-create' },
      payload: draft,
    });
    assert.equal(create.statusCode, 201);
    const run = create.json().run;
    assert.equal(run.state, 'queued');
    const claim = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-workers/claim',
      headers: { authorization: `Bearer ${worker.token}` },
      payload: {},
    });
    assert.equal(claim.statusCode, 200);
    const lease = claim.json().lease;
    assert.equal(lease.runId, run.id);
    assert.equal(claim.json().run.id, run.id);
    const foreign = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-workers/publish',
      headers: { authorization: `Bearer ${otherWorker.token}` },
      payload: {
        lease,
        publication: {
          sequence: 1,
          checkpointRef: 'checkpoint-1',
          completedSourceIds: [],
          state: 'completed',
        },
      },
    });
    assert.equal(foreign.statusCode, 403);
    const published = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-workers/publish',
      headers: { authorization: `Bearer ${worker.token}` },
      payload: {
        lease,
        publication: {
          sequence: 1,
          checkpointRef: 'checkpoint-1',
          completedSourceIds: [],
          state: 'completed',
        },
      },
    });
    assert.equal(published.statusCode, 200);
    assert.equal(published.json().run.state, 'completed');
    const replay = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-runs',
      headers: { ...f.auth, 'idempotency-key': 'generated-workflow-create' },
      payload: draft,
    });
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.json().run.id, run.id);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/workflow-runs',
          headers: { ...f.auth, 'idempotency-key': 'generated-workflow-create' },
          payload: { ...draft, options: { ...draft.options, online: true } },
        })
      ).statusCode,
      409,
    );
    const nextRun = f.catalog.workflowRuns.createRun(draft, f.owner.id);
    const firstLease = f.catalog.workflowRuns.claimRun(host.id);
    assert.ok(firstLease);
    f.catalog.workflowRuns.recoverRuns(Date.now() + 60_001);
    f.catalog.workflowRuns.resumeRun(nextRun.id, f.owner.id);
    const nextLease = f.catalog.workflowRuns.claimRun(host.id);
    assert.ok(nextLease);
    assert.ok(nextLease.fence > firstLease.fence);
    const stale = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-workers/publish',
      headers: { authorization: `Bearer ${worker.token}` },
      payload: {
        lease: firstLease,
        publication: { sequence: 1, checkpointRef: 'stale-checkpoint', completedSourceIds: [] },
      },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(
      (
        await f.app.inject({
          method: 'GET',
          url: `/api/v1/workflow-runs/${run.id}`,
          headers: f.auth,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/workflow-runs',
          headers: f.auth,
          payload: { ...draft, options: { ...draft.options, apiKey: 'generated-secret' } },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/workflow-runs',
          headers: f.auth,
          payload: { ...draft, options: { ...draft.options, shareImages: 'true' } },
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.dispose();
  }
});

test('review discovery advertises only bounded package summaries and filters empty-library history', async () => {
  const f = await libraryFixture();
  try {
    const enrollment = issueToken(),
      worker = issueToken();
    const host = f.catalog.workflowIdentities.createHost(
      f.owner.id,
      'Review host',
      enrollment.hash,
      Date.now() + 600000,
    );
    f.catalog.workflowIdentities.enrollHost(enrollment.hash, worker.hash);
    const headers = { authorization: `Bearer ${worker.token}` };
    const packages = [
      {
        id: 'org.ecs.library-cleanup',
        name: 'Library cleanup',
        version: '1.0.0',
        digest: 'c'.repeat(64),
        kind: 'workflow',
      },
    ];
    const cleanupPackage = packages[0];
    assert.ok(cleanupPackage);
    const advertised = await f.app.inject({
      method: 'POST',
      url: '/api/v1/workflow-workers/advertise',
      headers,
      payload: { packages },
    });
    assert.equal(advertised.statusCode, 200, advertised.body);
    const listed = await f.app.inject({ url: '/api/v1/workflow-hosts', headers: f.auth });
    assert.deepEqual(listed.json().items[0].packages, packages);
    assert.ok(listed.json().items[0].lastSeenAt);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/workflow-workers/advertise',
          headers,
          payload: { packages: [{ ...packages[0], apiKey: 'private' }] },
        })
      ).statusCode,
      400,
    );
    const other = f.catalog.createLibrary(f.owner.id, 'Other empty shelf');
    for (const libraryId of [f.library.id, other.id])
      f.catalog.workflowRuns.createRun(
        {
          workflowId: cleanupPackage.id,
          workflowDigest: cleanupPackage.digest,
          hostId: host.id,
          scope: { libraryId },
          options: { online: false, checksum: false, shareImages: false },
        },
        f.owner.id,
      );
    const history = await f.app.inject({
      url: `/api/v1/workflow-runs?libraryId=${other.id}`,
      headers: f.auth,
    });
    assert.equal(history.statusCode, 200, history.body);
    assert.equal(history.json().items.length, 1);
    assert.equal(history.json().items[0].scope.libraryId, other.id);
    assert.equal((await f.app.inject({ url: '/api/v1/workflow-hosts', headers })).statusCode, 401);
  } finally {
    await f.close();
  }
});
