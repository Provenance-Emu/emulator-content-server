import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContentError,
  type WorkflowApplication,
  type WorkflowProposal,
  type WorkflowProposalVersion,
  type WorkflowRun,
  type WorkflowRunDraft,
} from '@ecs/client';
import { get } from 'svelte/store';
import { createWorkflowRuns } from '../src/lib/workflow-runs.js';

const run: WorkflowRun = {
  id: 'run',
  actorId: 'owner',
  hostId: 'host',
  workflowId: 'org.ecs.library-cleanup',
  workflowDigest: 'a'.repeat(64),
  scope: { libraryId: 'a' },
  options: { online: false, checksum: true, shareImages: false },
  state: 'completed',
  revision: 3,
  total: 2,
  processed: 2,
  createdAt: '',
  updatedAt: '',
  error: null,
};
function proposal(id: string, sourceId = id): WorkflowProposal {
  return {
    id,
    version: 1,
    digest: `digest-${id}`,
    runId: run.id,
    findingId: `finding-${id}`,
    sourceId,
    sourceValidator: 'stamp',
    selectionRevision: 0,
    currentValueDigest: 'old',
    change: {
      action: 'replace-metadata',
      candidateId: id,
      artifactId: null,
      snapshotJson: JSON.stringify({ title: id, metadata: {} }),
    },
    evidenceIds: ['evidence'],
    reason: 'Catalog disagrees with the saved title',
  };
}
function fixture() {
  const approvals: { refs: WorkflowProposalVersion[]; key: string }[] = [];
  const applications: string[] = [];
  const decisions: string[] = [];
  const p = proposal('first'),
    q = proposal('second');
  const client = {
    workflowHosts: async () => ({ items: [] }),
    workflowRuns: async () => ({ items: [run], nextCursor: null }),
    workflowRun: async () => ({ run }),
    workflowFindings: async () => ({ items: [], nextCursor: null }),
    workflowResults: async () => ({ items: [], nextCursor: null }),
    workflowProposals: async (_id: string, cursor?: string) => ({
      items: [cursor ? q : p],
      nextCursor: cursor ? null : 'second',
    }),
    sourceSelections: async (id: string) => ({ sourceId: id, revision: 0, matches: [] }),
    workflowApplications: async () => ({ items: [] as WorkflowApplication[], nextCursor: null }),
    createWorkflowRun: async (_draft: WorkflowRunDraft, _key?: string) => ({ run }),
    decideWorkflowFinding: async (_run: string, id: string, decision: string) => {
      decisions.push(decision);
      return {
        finding: {
          id,
          runId: run.id,
          sourceId: id,
          kind: 'suspected-mismatch' as const,
          ruleVersion: '1',
          currentValueDigest: 'old',
          evidenceDigest: 'e',
          reason: 'why',
          evidenceIds: [],
          fingerprint: id,
          dismissed: true,
        },
      };
    },
    approveWorkflowBatch: async (
      _id: string,
      _revision: number,
      refs: WorkflowProposalVersion[],
      key: string,
    ) => {
      approvals.push({ refs, key });
      return {
        approval: {
          id: 'approval',
          actorId: 'owner',
          runId: run.id,
          runRevision: run.revision,
          proposalVersionsJson: JSON.stringify(refs),
          digest: 'approval-digest',
          createdAt: '',
        },
      };
    },
    applyWorkflowApproval: async (_id: string, id: string) => {
      applications.push(id);
      return { applications: [] as WorkflowApplication[] };
    },
    workflowApplicationBatch: async (_id: string) => ({
      applications: [] as WorkflowApplication[],
    }),
    undoWorkflowApplication: async () => {
      throw Error('unused');
    },
    cancelWorkflowRun: async () => ({ run }),
    resumeWorkflowRun: async () => ({ run }),
  };
  return { client, p, q, approvals, applications, decisions };
}
test('selected exact versions survive paging and approval never adds an unselected proposal', async () => {
  const f = fixture(),
    c = createWorkflowRuns(f.client, { libraryId: 'a' });
  await c.choose(run.id);
  c.select(f.p, true);
  await c.nextProposals();
  assert.deepEqual(get(c).proposals, [f.q]);
  assert.deepEqual(get(c).selected, [f.p]);
  await c.approve();
  assert.deepEqual(f.approvals[0]?.refs, [{ id: f.p.id, version: 1, digest: f.p.digest }]);
  assert.equal(get(c).approval?.id, 'approval');
  c.dispose();
});
test('scope changes and authorization failures discard late responses and reviewed data', async () => {
  const f = fixture();
  let release!: (value: { run: WorkflowRun }) => void;
  f.client.workflowRun = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const c = createWorkflowRuns(f.client, { libraryId: 'a' });
  const pending = c.choose(run.id);
  await c.setScope({ libraryId: 'b' });
  release({ run });
  await pending;
  assert.equal(get(c).scope.libraryId, 'b');
  assert.equal(get(c).run, null);
  assert.deepEqual(get(c).proposals, []);
  f.client.workflowRun = async () => ({ run });
  await c.choose(run.id);
  c.select(f.p, true);
  f.client.workflowRun = async () => {
    throw new ContentError(401, null);
  };
  await c.refresh();
  assert.deepEqual(get(c).selected, []);
  assert.deepEqual(get(c).proposals, []);
  c.dispose();
});
test('keep and dismiss stay distinct; ambiguous apply recovers the same partial batch', async () => {
  const f = fixture();
  const receipt: WorkflowApplication = {
    id: 'application',
    approvalId: 'approval',
    sourceId: f.p.sourceId,
    status: 'applied',
    beforeRevision: 0,
    afterRevision: 1,
    resultJson: JSON.stringify({ proposals: [{ id: f.p.id, version: 1, digest: f.p.digest }] }),
    undoExpiresAt: '2099-01-01',
  };
  f.client.applyWorkflowApproval = async (_approval, id) => {
    f.applications.push(id);
    throw new TypeError('lost response');
  };
  f.client.workflowApplicationBatch = async (id) => ({ applications: [{ ...receipt, id }] });
  const c = createWorkflowRuns(f.client, { libraryId: 'a' });
  await c.choose(run.id);
  await c.decide(f.p.findingId, 'keep');
  await c.decide(f.q.findingId, 'dismiss');
  assert.deepEqual(f.decisions, ['keep', 'dismiss']);
  c.select(f.p, true);
  await c.approve();
  await c.apply();
  assert.equal(f.applications.length, 1);
  assert.equal(get(c).applications[0]?.status, 'applied');
  assert.equal(get(c).selected.length, 0);
  c.dispose();
});
test('changing a proposal version clears its selection rather than upgrading approval silently', async () => {
  const f = fixture(),
    c = createWorkflowRuns(f.client, { libraryId: 'a' });
  await c.choose(run.id);
  c.select(f.p, true);
  f.client.workflowProposals = async () => ({
    items: [{ ...f.p, version: 2, digest: 'new-digest' }],
    nextCursor: null,
  });
  await c.refresh();
  assert.equal(get(c).selected.length, 0);
  assert.match(get(c).notice ?? '', /review/i);
  c.dispose();
});

test('an interrupted partial batch retains approval and replays the same application ID for remaining sources', async () => {
  const f = fixture();
  const receipts = (ids: string[], applicationId: string) =>
    ids.map((id) => ({
      id: applicationId,
      approvalId: 'approval',
      sourceId: id,
      status: 'applied' as const,
      beforeRevision: 0,
      afterRevision: 1,
      resultJson: JSON.stringify({ proposals: [{ id, version: 1, digest: `digest-${id}` }] }),
      undoExpiresAt: '2099-01-01',
    }));
  f.client.applyWorkflowApproval = async (_approval, id) => {
    f.applications.push(id);
    return {
      applications: receipts(f.applications.length === 1 ? ['first'] : ['first', 'second'], id),
    };
  };
  const c = createWorkflowRuns(f.client, { libraryId: 'a' });
  await c.choose(run.id);
  c.select(f.p, true);
  await c.nextProposals();
  c.select(f.q, true);
  await c.approve();
  await c.apply();
  assert.equal(get(c).approval?.id, 'approval');
  assert.deepEqual(
    get(c).selected.map((p) => p.id),
    ['second'],
  );
  await c.apply();
  assert.equal(get(c).approval, null);
  assert.equal(get(c).selected.length, 0);
  assert.equal(f.applications[0], f.applications[1]);
  c.dispose();
});
