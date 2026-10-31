import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openWorkflowState } from '../src/workflows/state.js';

const request = {
  operationId: 'operation-1',
  capability: 'text.generate',
  major: 1,
  input: { prompt: 'Generated title' },
  deadline: '2030-01-01T00:00:00.000Z',
};
const operation = {
  runId: 'run-1',
  sourceId: 'source-1',
  stepId: 'reason',
  bindingId: 'reasoner',
  workflowDigest: 'a'.repeat(64),
  request,
};

test('host state reuses completed steps and persists pending handles across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-workflow-state-'));
  let state = await openWorkflowState(directory);
  try {
    state.initializeRun('run-1');
    const lease = { runId: 'run-1', hostId: 'host-1', fence: 1, expiresAt: '2030-01-01T00:01:00Z' };
    state.saveLease(lease);
    state.initializeSource('run-1', 'source-1', 'a'.repeat(64), { title: 'Generated' });
    const plan = {
      state: 'waiting' as const,
      checkpoint: { stage: 'review' },
      operations: [
        {
          id: 'reason',
          binding: 'reasoner',
          capability: 'text.generate',
          major: 1,
          input: request.input,
        },
      ],
    };
    state.savePlan('run-1', 'source-1', plan);
    assert.equal(state.beginOperation(operation).state, 'prepared');
    state.markSubmitting(request.operationId);
    state.saveAcceptedHandle(request.operationId, { jobId: 'generated-job-1' });
    state.close();
    state = await openWorkflowState(directory);
    assert.deepEqual(state.savedLeases(), [lease]);
    assert.equal(state.beginOperation(operation).state, 'pending');
    assert.deepEqual(state.getOperation(request.operationId)?.handle, { jobId: 'generated-job-1' });
    assert.deepEqual(state.pendingPlan('run-1', 'source-1'), plan);
    assert.deepEqual(state.resumeSnapshot('run-1', 'source-1')?.completed, {});
    const publication = state.commitStep(
      request.operationId,
      { state: 'completed', output: { value: 'Generated result' } },
      { stage: 'review' },
    );
    assert.equal(publication.sequence, 1);
    assert.equal(state.pendingPublications('run-1').length, 1);
    assert.equal(state.beginOperation(operation).state, 'completed');
    assert.equal(state.resumeSnapshot('run-1', 'source-1')?.completed.reason?.state, 'completed');
    state.finishPlan('run-1', 'source-1');
    assert.equal(state.pendingPlan('run-1', 'source-1'), null);
    state.acknowledgePublication('run-1', 1);
    state.close();
    state = await openWorkflowState(directory);
    assert.deepEqual(state.pendingPublications('run-1'), []);
    assert.deepEqual(state.resumeSnapshot('run-1', 'source-1')?.checkpoint, { stage: 'review' });
    assert.throws(() =>
      state.beginOperation({
        ...operation,
        request: { ...request, input: { prompt: 'Different input' } },
      }),
    );
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('source and run completion retain publication intents and never emit duplicate completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-workflow-completion-'));
  const state = await openWorkflowState(directory);
  try {
    assert.equal(state.hasRun('run-1'), false);
    state.initializeRun('run-1');
    assert.equal(state.hasRun('run-1'), true);
    state.initializeSource('run-1', 'source-1', 'a'.repeat(64), {});
    state.savePlan('run-1', 'source-1', {
      state: 'completed',
      checkpoint: null,
      operations: [],
      output: { generated: true },
    });
    state.completeSource('run-1', 'source-1');
    state.finishRun('run-1');
    assert.equal(state.sourceCompleted('run-1', 'source-1'), true);
    assert.equal(state.runFinished('run-1'), true);
    assert.deepEqual(state.pendingPublications('run-1')[0]?.sourceOutputs, [
      { sourceId: 'source-1', outputJson: '{"generated":true}' },
    ]);
    assert.deepEqual(
      state
        .pendingPublications('run-1')
        .map((item) => [item.sequence, item.completedSourceIds, item.state]),
      [
        [1, ['source-1'], undefined],
        [2, [], 'completed'],
      ],
    );
    state.completeSource('run-1', 'source-1');
    state.finishRun('run-1');
    assert.equal(state.pendingPublications('run-1').length, 2);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('result, checkpoint and publication intent commit atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-workflow-state-atomic-'));
  const state = await openWorkflowState(directory);
  const raw = new DatabaseSync(join(directory, 'workflow-host.sqlite'));
  try {
    state.initializeRun('run-1');
    state.initializeSource('run-1', 'source-1', 'a'.repeat(64), { title: 'Generated' });
    state.beginOperation(operation);
    state.markSubmitting(request.operationId);
    raw.exec(
      "CREATE TRIGGER generated_publication_failure BEFORE INSERT ON workflow_publications BEGIN SELECT RAISE(ABORT,'generated-failure'); END;",
    );
    assert.throws(() =>
      state.commitStep(request.operationId, { state: 'completed', output: {} }, { stage: 'done' }),
    );
    assert.equal(state.getOperation(request.operationId)?.state, 'submitting');
    assert.deepEqual(state.resumeSnapshot('run-1', 'source-1')?.checkpoint, null);
    assert.deepEqual(state.pendingPublications('run-1'), []);
    raw.exec('DROP TRIGGER generated_publication_failure');
    state.markUncertain(request.operationId);
    assert.equal(state.beginOperation(operation).state, 'uncertain');
    assert.throws(() => state.markSubmitting(request.operationId));
  } finally {
    raw.close();
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('host state rejects credential-bearing payloads and publicly readable state directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-workflow-private-'));
  const state = await openWorkflowState(directory);
  try {
    state.initializeRun('run-1');
    assert.throws(() =>
      state.initializeSource('run-1', 'source-1', 'a'.repeat(64), { apiKey: 'generated-secret' }),
    );
    state.initializeSource('run-1', 'source-1', 'a'.repeat(64), {});
    assert.throws(() =>
      state.beginOperation({
        ...operation,
        request: { ...request, input: { authorization: 'generated-secret' } },
      }),
    );
  } finally {
    state.close();
  }
  try {
    if (process.platform !== 'win32') {
      await chmod(directory, 0o755);
      await assert.rejects(openWorkflowState(directory));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
