import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { workflowFixture } from './workflow-fixture.js';

async function reviewFixture(count = 1) {
  const f = await workflowFixture({ count });
  for (const source of f.sources) {
    const result =
      source.id === f.source.id
        ? f.inspection
        : (
            await f.app.inject({
              method: 'POST',
              url: `${f.baseUrl}/sources/${source.id}/catalog`,
              headers: f.workerHeaders,
              payload: {},
            })
          ).json();
    const metadata = result.candidates.find((c: { kind: string }) => c.kind === 'metadata'),
      artwork = result.candidates.find((c: { kind: string }) => c.kind === 'artwork');
    assert.ok(metadata && artwork);
    const observations = [
      {
        sourceId: source.id,
        kind: 'suspected-mismatch',
        reason: 'Catalog details need review',
        evidenceIds: [...result.facts.evidenceIds, ...metadata.evidenceIds],
        candidateIds: [metadata.id],
      },
      {
        sourceId: source.id,
        kind: 'missing-front-artwork',
        reason: 'Cover missing',
        evidenceIds: [...result.facts.evidenceIds, ...artwork.evidenceIds],
        candidateIds: [artwork.id],
      },
    ];
    const response = await f.app.inject({
      method: 'POST',
      url: `${f.baseUrl}/suggestions`,
      headers: f.workerHeaders,
      payload: { sourceId: source.id, observations },
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  const proposals = f.catalog.workflowProposals.pageProposals(f.run.id).items;
  assert.equal(proposals.length, count * 2);
  return {
    ...f,
    proposals,
    versions: proposals.map(({ id, version, digest }) => ({ id, version, digest })),
    runRevision: f.catalog.workflowRuns.getRun(f.run.id)?.revision,
  };
}

test('owner approval applies only exact reviewed slots, preserves files despite organization policy, and safely undoes', async () => {
  const f = await reviewFixture();
  try {
    const targetPath = join(f.base, 'organized');
    await mkdir(targetPath);
    const target = f.catalog.createContentRoot({
      path: targetPath,
      label: 'Organized',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    f.catalog.setSourceOrganizationPolicy({
      sourceRootId: f.root.id,
      targetRootId: target.id,
      libraryId: f.library.id,
      sourceRootPath: f.path,
      targetRootPath: targetPath,
      mode: 'move',
      enabledBy: f.owner.id,
      enabledAt: new Date().toISOString(),
    });
    const url = `/api/v1/workflow-runs/${f.run.id}/approvals`;
    const headers = { ...f.auth, 'idempotency-key': 'generated-approval-1' };
    const payload = { runRevision: f.runRevision, proposals: f.versions };
    assert.equal(
      (await f.app.inject({ method: 'POST', url, headers: f.workerHeaders, payload })).statusCode,
      401,
    );
    const approved = await f.app.inject({ method: 'POST', url, headers, payload });
    assert.equal(approved.statusCode, 201, approved.body);
    const approval = approved.json().approval;
    const replay = await f.app.inject({ method: 'POST', url, headers, payload });
    assert.equal(replay.json().approval.id, approval.id);
    const expanded = await f.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { ...payload, proposals: f.versions.slice(0, 1) },
    });
    assert.equal(expanded.statusCode, 409);
    const applyUrl = `/api/v1/workflow-approvals/${approval.id}/apply`;
    const applied = await f.app.inject({
      method: 'POST',
      url: applyUrl,
      headers: f.auth,
      payload: { applicationId: 'generated-application-1' },
    });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal(applied.json().applications[0].status, 'applied');
    const state = f.catalog.sourceMatches(f.source.id);
    assert.equal(state.matches.length, 2);
    const history = await f.app.inject({
      url: `/api/v1/workflow-runs/${f.run.id}/applications?limit=1`,
      headers: f.auth,
    });
    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(history.json().items, applied.json().applications);
    assert.equal(history.json().nextCursor, null);
    assert.deepEqual(
      Buffer.from(f.catalog.sourceMatchContent(f.source.id, 'artwork') ?? []),
      f.png,
    );
    assert.deepEqual(await readFile(join(f.path, 'Game.j64')), Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(await readdir(targetPath), []);
    assert.equal(f.catalog.getSource(f.source.id)?.relativePath, 'Game.j64');
    const repeated = await f.app.inject({
      method: 'POST',
      url: applyUrl,
      headers: f.auth,
      payload: { applicationId: 'generated-application-1' },
    });
    assert.deepEqual(repeated.json(), applied.json());
    const undo = await f.app.inject({
      method: 'POST',
      url: `/api/v1/workflow-applications/generated-application-1/sources/${f.source.id}/undo`,
      headers: f.auth,
      payload: {},
    });
    assert.equal(undo.statusCode, 200, undo.body);
    assert.equal(undo.json().application.status, 'undone');
    assert.deepEqual(f.catalog.sourceMatches(f.source.id).matches, []);
  } finally {
    await f.dispose();
  }
});

test('source changes conflict with application and later manual edits conflict with undo', async () => {
  const f = await reviewFixture();
  try {
    const approval = f.catalog.workflowApplications.approveWorkflowBatch(
      f.run.id,
      f.runRevision ?? 0,
      f.versions,
      f.owner.id,
      'source-change-approval',
    );
    await writeFile(join(f.path, 'Game.j64'), Buffer.from([5, 6, 7, 8]));
    const conflict = await f.app.inject({
      method: 'POST',
      url: `/api/v1/workflow-approvals/${approval.id}/apply`,
      headers: f.auth,
      payload: { applicationId: 'source-change-application' },
    });
    assert.equal(conflict.statusCode, 200, conflict.body);
    assert.equal(conflict.json().applications[0].status, 'conflict');
    assert.deepEqual(f.catalog.sourceMatches(f.source.id).matches, []);
  } finally {
    await f.dispose();
  }
  const g = await reviewFixture();
  try {
    const approval = g.catalog.workflowApplications.approveWorkflowBatch(
      g.run.id,
      g.runRevision ?? 0,
      g.versions,
      g.owner.id,
      'manual-edit-approval',
    );
    const applied = await g.app.inject({
      method: 'POST',
      url: `/api/v1/workflow-approvals/${approval.id}/apply`,
      headers: g.auth,
      payload: { applicationId: 'manual-edit-application' },
    });
    assert.equal(applied.statusCode, 200, applied.body);
    const current = g.catalog.sourceMatches(g.source.id),
      metadata = current.matches.find((m) => m.kind === 'metadata');
    assert.ok(metadata);
    const edited = g.catalog.saveSourceMatch(
      g.source.id,
      current.revision,
      'metadata',
      { ...metadata, id: 'later-edit', title: 'Later manual choice' },
      null,
      g.owner.id,
    );
    const undo = await g.app.inject({
      method: 'POST',
      url: `/api/v1/workflow-applications/manual-edit-application/sources/${g.source.id}/undo`,
      headers: g.auth,
      payload: {},
    });
    assert.equal(undo.statusCode, 409, undo.body);
    assert.deepEqual(g.catalog.sourceMatches(g.source.id), edited);
  } finally {
    await g.dispose();
  }
});

test('a conflicting source does not block another source, and unapproved slots stay untouched', async () => {
  const f = await reviewFixture(2);
  try {
    const other = f.sources.find((s) => s.id !== f.source.id);
    assert.ok(other);
    const selected = f.proposals.filter(
      (p) => p.sourceId === f.source.id || p.change.action === 'replace-metadata',
    );
    const approval = f.catalog.workflowApplications.approveWorkflowBatch(
      f.run.id,
      f.runRevision ?? 0,
      selected.map(({ id, version, digest }) => ({ id, version, digest })),
      f.owner.id,
      'partial-batch-approval',
    );
    const original = JSON.parse(
      f.proposals.find((p) => p.sourceId === f.source.id && p.change.action === 'replace-metadata')
        ?.change.snapshotJson ?? 'null',
    );
    assert.ok(original);
    const manual = f.catalog.saveSourceMatch(
      f.source.id,
      0,
      'metadata',
      { ...original, id: 'manual-selection', title: 'Manual selection' },
      null,
      f.owner.id,
    );
    const applied = await f.app.inject({
      method: 'POST',
      url: `/api/v1/workflow-approvals/${approval.id}/apply`,
      headers: f.auth,
      payload: { applicationId: 'partial-batch-application' },
    });
    assert.equal(applied.statusCode, 200, applied.body);
    const receipts = applied.json().applications as { sourceId: string; status: string }[];
    assert.equal(receipts.find((r) => r.sourceId === f.source.id)?.status, 'conflict');
    assert.equal(receipts.find((r) => r.sourceId === other.id)?.status, 'applied');
    assert.deepEqual(f.catalog.sourceMatches(f.source.id), manual);
    assert.deepEqual(
      f.catalog.sourceMatches(other.id).matches.map((m) => m.kind),
      ['metadata'],
    );
    assert.equal(f.catalog.sourceMatchContent(other.id, 'artwork'), null);
    const page = await f.app.inject({
      url: `/api/v1/workflow-runs/${f.run.id}/applications?limit=1`,
      headers: f.auth,
    });
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(page.json().items.length, 1);
    assert.ok(page.json().nextCursor);
    const next = await f.app.inject({
      url: `/api/v1/workflow-runs/${f.run.id}/applications?limit=1&cursor=${encodeURIComponent(page.json().nextCursor)}`,
      headers: f.auth,
    });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().items.length, 1);
    assert.equal(next.json().nextCursor, null);
    assert.notEqual(next.json().items[0].sourceId, page.json().items[0].sourceId);
  } finally {
    await f.dispose();
  }
});

test('a later owner selection conflicts with apply without overwriting that choice', async () => {
  const f = await reviewFixture();
  try {
    const approved = await f.app.inject({
      method: 'POST',
      url: `/api/v1/workflow-runs/${f.run.id}/approvals`,
      headers: { ...f.auth, 'idempotency-key': 'generated-approval-1' },
      payload: { runRevision: f.runRevision, proposals: f.versions },
    });
    assert.equal(approved.statusCode, 201, approved.body);
    const approval = approved.json().approval;
    const proposed = JSON.parse(
      f.proposals.find((p) => p.change.action === 'replace-metadata')?.change.snapshotJson ??
        'null',
    );
    assert.ok(proposed);
    f.catalog.saveSourceMatch(
      f.source.id,
      0,
      'metadata',
      { ...proposed, id: 'manual-choice', title: 'Manual choice' },
      null,
      f.owner.id,
    );
    const current = f.catalog.sourceMatches(f.source.id);
    const applied = await f.app.inject({
      method: 'POST',
      url: `/api/v1/workflow-approvals/${approval.id}/apply`,
      headers: f.auth,
      payload: { applicationId: 'generated-application-1' },
    });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal(applied.json().applications[0].status, 'conflict');
    assert.deepEqual(f.catalog.sourceMatches(f.source.id), current);
  } finally {
    await f.dispose();
  }
});
