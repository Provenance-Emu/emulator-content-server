import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { workflowFixture } from './workflow-fixture.js';

const day = 86_400_000;
test('collection bounds each pass and preserves pending, selected and unexpired undo artwork', async () => {
  const f = await workflowFixture();
  const db = new DatabaseSync(join(f.base, 'data/library.sqlite'));
  const now = Date.now();
  try {
    for (const [index, kind] of ['pending', 'selected', 'undo', 'staging', 'orphan'].entries()) {
      f.catalog.workflowProposals.stageArtifact(
        {
          id: kind,
          runId: f.run.id,
          sourceId: f.source.id,
          sha256: createHash('sha256').update(f.png).digest('hex'),
          size: f.png.length,
          contentType: 'image/png',
          width: 2,
          height: 2,
          attributionJson: '{}',
          expiresAt: null,
        },
        f.png,
        `staging:${index}`,
      );
    }
    db.prepare('UPDATE workflow_artifacts SET created_at=?').run(
      new Date(now - 31 * day).toISOString(),
    );
    db.prepare(
      "UPDATE workflow_artifact_refs SET reference_id='live-proposal:1' WHERE artifact_id='pending'",
    ).run();
    db.prepare(
      "UPDATE workflow_artifact_refs SET reference_kind='selected' WHERE artifact_id='selected'",
    ).run();
    db.prepare(
      "UPDATE workflow_artifact_refs SET reference_kind='undo' WHERE artifact_id='undo'",
    ).run();
    db.prepare("DELETE FROM workflow_artifact_refs WHERE artifact_id='orphan'").run();
    db.prepare("UPDATE workflow_runs SET state='completed',updated_at=? WHERE id=?").run(
      new Date(now - 31 * day).toISOString(),
      f.run.id,
    );
    assert.equal(f.catalog.workflowProposals.collectWorkflowArtifacts(now, 1).artifactsDeleted, 1);
    f.catalog.workflowProposals.collectWorkflowArtifacts(now, 100);
    assert.deepEqual(
      db
        .prepare('SELECT id FROM workflow_artifacts ORDER BY id')
        .all()
        .map((r) => r.id),
      ['pending', 'selected', 'undo'],
    );
    // A new committed reference wins before the next collection transaction.
    db.prepare("DELETE FROM workflow_artifact_refs WHERE artifact_id='pending'").run();
    db.prepare(
      "INSERT INTO workflow_artifact_refs VALUES('pending',?,?,'selected','new-selection')",
    ).run(f.run.id, f.source.id);
    f.catalog.workflowProposals.collectWorkflowArtifacts(now + 100 * day);
    assert.ok(f.catalog.workflowProposals.getArtifact(f.run.id, f.source.id, 'pending'));
    assert.throws(() => f.catalog.workflowProposals.collectWorkflowArtifacts(now, 101));
  } finally {
    db.close();
    await f.close();
  }
});

test('explicitly dismissed review expires after the grace period while undecided proposals stay live', async () => {
  const f = await workflowFixture();
  const db = new DatabaseSync(join(f.base, 'data/library.sqlite'));
  const now = Date.now();
  try {
    const finding = f.catalog.workflowProposals.addFinding(f.run.id, {
      sourceId: f.source.id,
      kind: 'missing-front-artwork',
      ruleVersion: 'generated',
      currentValueDigest: 'a'.repeat(64),
      evidenceDigest: 'b'.repeat(64),
      evidenceIds: [],
      reason: 'Generated',
    });
    const artifact = {
      id: 'dismissed-art',
      runId: f.run.id,
      sourceId: f.source.id,
      sha256: createHash('sha256').update(f.png).digest('hex'),
      size: f.png.length,
      contentType: 'image/png',
      width: 2,
      height: 2,
      attributionJson: '{}',
      expiresAt: null,
    };
    f.catalog.workflowProposals.stageArtifact(artifact, f.png, 'staging:generated');
    f.catalog.workflowProposals.saveProposal({
      id: 'dismissed-proposal',
      runId: f.run.id,
      sourceId: f.source.id,
      findingId: finding.id,
      sourceValidator: 'c'.repeat(64),
      selectionRevision: 0,
      currentValueDigest: 'a'.repeat(64),
      change: {
        action: 'replace-front-artwork',
        candidateId: 'cover',
        artifactId: artifact.id,
        snapshotJson: '{}',
      },
      evidenceIds: [],
      reason: 'Generated',
    });
    db.prepare("UPDATE workflow_runs SET state='completed',updated_at=? WHERE id=?").run(
      new Date(now).toISOString(),
      f.run.id,
    );
    f.catalog.workflowProposals.collectWorkflowArtifacts(now + 31 * day);
    assert.ok(f.catalog.workflowProposals.getArtifact(f.run.id, f.source.id, artifact.id));
    f.catalog.workflowProposals.recordDecision(finding.id, 'dismiss', f.owner.id);
    f.catalog.workflowProposals.collectWorkflowArtifacts(now + 29 * day);
    assert.ok(f.catalog.workflowProposals.getArtifact(f.run.id, f.source.id, artifact.id));
    f.catalog.workflowProposals.collectWorkflowArtifacts(now + 31 * day);
    assert.equal(f.catalog.workflowProposals.getArtifact(f.run.id, f.source.id, artifact.id), null);
  } finally {
    db.close();
    await f.close();
  }
});
