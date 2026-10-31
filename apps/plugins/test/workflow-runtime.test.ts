import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WorkflowPlan } from '@ecs/plugins/workflows';
import type { WorkflowLease, WorkflowPublication, WorkflowRun } from '@ecs/protocol';
import {
  type ResolvedWorkflowBinding,
  runWorkflowLease,
  type WorkflowRuntimeDependencies,
} from '../src/workflows/runtime.js';
import { openWorkflowState } from '../src/workflows/state.js';

const run: WorkflowRun = {
  id: 'run-1',
  actorId: 'owner-1',
  hostId: 'host-1',
  workflowId: 'ecs.cleanup',
  workflowDigest: 'a'.repeat(64),
  scope: { libraryId: 'library-1' },
  options: { online: false, checksum: false, shareImages: false },
  state: 'running',
  revision: 1,
  total: 1,
  processed: 0,
  createdAt: '2030-01-01T00:00:00Z',
  updatedAt: '2030-01-01T00:00:00Z',
  error: null,
};
const lease: WorkflowLease = {
  runId: run.id,
  hostId: run.hostId,
  fence: 1,
  expiresAt: '2030-01-01T00:01:00Z',
};
const waiting: WorkflowPlan = {
  state: 'waiting',
  checkpoint: { step: 1 },
  operations: [
    {
      id: 'inspect',
      binding: 'catalog',
      capability: 'catalog.search',
      major: 1,
      input: { query: 'Generated' },
    },
  ],
};

async function fixture(binding: ResolvedWorkflowBinding) {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-runtime-'));
  const state = await openWorkflowState(directory);
  const publications: WorkflowPublication[] = [];
  const deps: WorkflowRuntimeDependencies = {
    state,
    run,
    async assertWorkflowAvailable() {},
    async advance(snapshot) {
      return snapshot.completed.inspect
        ? { state: 'completed', checkpoint: null, operations: [], output: { done: true } }
        : waiting;
    },
    async resolveBinding() {
      return binding;
    },
    async work() {
      return {
        items: publications.some((p) => p.completedSourceIds.length)
          ? []
          : [
              {
                sourceId: 'source-1',
                indexValidator: 'generated-facts',
                selectionRevision: 1,
                state: 'pending',
              },
            ],
        nextCursor: null,
      };
    },
    async publish(_lease, p) {
      if (!publications.some((old) => old.sequence === p.sequence)) publications.push(p);
    },
    async heartbeat(current) {
      return current;
    },
    async publishPlan() {},
    async pause() {},
  };
  return {
    state,
    deps,
    publications,
    async close() {
      state.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('runtime polls a saved handle and replays an acknowledged publication without another start', async () => {
  let starts = 0,
    polls = 0;
  const f = await fixture({
    id: 'catalog-v1',
    async invoke(method, _request, _handle, beforeDispatch) {
      await beforeDispatch();
      if (method === 'start') {
        starts++;
        return { state: 'pending', resumeHandle: { job: 'generated' }, pollAfterMs: 1 };
      }
      polls++;
      return { state: 'completed', output: { candidates: [] } };
    },
  });
  try {
    const publish = f.deps.publish;
    let fail = true;
    f.deps.publish = async (current, p) => {
      await publish(current, p);
      if (fail) {
        fail = false;
        throw new Error('Generated lost acknowledgement');
      }
    };
    await assert.rejects(
      runWorkflowLease(lease, f.deps, new AbortController().signal),
      /acknowledgement/,
    );
    assert.equal(f.state.pendingPublications(run.id).length, 1);
    await runWorkflowLease({ ...lease, fence: 2 }, f.deps, new AbortController().signal);
    assert.equal(starts, 1);
    assert.equal(polls, 1);
    assert.equal(f.state.runFinished(run.id), true);
    assert.deepEqual(
      f.publications.map((p) => p.sequence),
      [1, 2, 3],
    );
  } finally {
    await f.close();
  }
});

test('uncertain submission is durable and never retried as a fresh paid operation', async () => {
  let starts = 0;
  const f = await fixture({
    id: 'catalog-v1',
    async invoke(_method, _request, _handle, beforeDispatch) {
      await beforeDispatch();
      starts++;
      throw new Error('Generated connection lost after acceptance');
    },
  });
  try {
    await assert.rejects(
      runWorkflowLease(lease, f.deps, new AbortController().signal),
      /recovery/i,
    );
    await assert.rejects(
      runWorkflowLease({ ...lease, fence: 2 }, f.deps, new AbortController().signal),
      /recovery/i,
    );
    assert.equal(starts, 1);
  } finally {
    await f.close();
  }
});

test('failure before dispatch remains safe to resume; missing private state requires recovery', async () => {
  let starts = 0;
  const f = await fixture({
    id: 'catalog-v1',
    async invoke(_method, _request, _handle, beforeDispatch) {
      await beforeDispatch();
      starts++;
      return { state: 'completed', output: {} };
    },
  });
  try {
    await assert.rejects(
      runWorkflowLease({ ...lease, fence: 2 }, f.deps, new AbortController().signal),
      /recovery/i,
    );
    const resolver = f.deps.resolveBinding;
    f.deps.resolveBinding = async () => {
      throw new Error('Generated disabled binding');
    };
    await assert.rejects(runWorkflowLease(lease, f.deps, new AbortController().signal), /disabled/);
    f.deps.resolveBinding = resolver;
    await runWorkflowLease({ ...lease, fence: 2 }, f.deps, new AbortController().signal);
    assert.equal(starts, 1);
  } finally {
    await f.close();
  }
});

test('saved pending work resumes by polling and cancellation stops scheduling', async () => {
  let starts = 0,
    polls = 0,
    cancels = 0;
  const controller = new AbortController();
  const f = await fixture({
    id: 'catalog-v1',
    async invoke(method, _request, _handle, beforeDispatch) {
      await beforeDispatch();
      if (method === 'start') {
        starts++;
        return { state: 'pending', resumeHandle: { job: 'generated' }, pollAfterMs: 1 };
      }
      polls++;
      return { state: 'completed', output: {} };
    },
    async cancel() {
      cancels++;
    },
  });
  try {
    let fail = true;
    f.deps.pause = async () => {
      if (fail) {
        fail = false;
        throw new Error('Generated restart');
      }
    };
    await assert.rejects(runWorkflowLease(lease, f.deps, controller.signal), /restart/);
    await runWorkflowLease({ ...lease, fence: 2 }, f.deps, controller.signal);
    assert.equal(starts, 1);
    assert.equal(polls, 1);
    assert.equal(cancels, 0);
  } finally {
    await f.close();
  }
  const g = await fixture({
    id: 'catalog-v1',
    async invoke(_method, _request, _handle, beforeDispatch) {
      await beforeDispatch();
      return { state: 'pending', resumeHandle: { job: 'generated' }, pollAfterMs: 1 };
    },
    async cancel() {
      cancels++;
    },
  });
  try {
    g.deps.pause = async () => {
      controller.abort();
    };
    await assert.rejects(runWorkflowLease(lease, g.deps, controller.signal), /cancel/i);
    assert.equal(cancels, 1);
    assert.equal(g.state.runFinished(run.id), false);
  } finally {
    await g.close();
  }
});
