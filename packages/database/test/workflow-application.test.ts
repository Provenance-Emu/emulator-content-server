import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SourceMatchRecord } from '@ecs/domain';
import { CatalogDatabase } from '../src/catalog.js';
import { workflowDigest } from '../src/workflow-data.js';

async function fixture(sameCandidate = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-workflow-application-'));
  const path = join(directory, 'catalog.sqlite');
  const catalog = new CatalogDatabase(path);
  catalog.saveBootstrapHash('0'.repeat(64));
  const { userId } = catalog.bootstrap({
    bootstrapTokenHash: '0'.repeat(64),
    username: 'owner',
    passwordHash: 'generated',
    sessionHash: 'f'.repeat(64),
    libraryName: 'Generated',
  });
  const library = catalog.createLibrary(userId, 'Shelf');
  const root = catalog.createContentRoot({
    path: join(directory, 'files'),
    label: 'Files',
    libraryId: library.id,
    actorId: userId,
  });
  catalog.applyInspection({
    rootId: root.id,
    actorId: userId,
    online: true,
    files: [
      {
        relativePath: 'Game.nes',
        displayName: 'Game.nes',
        kind: 'rom',
        size: 4,
        blocks: 1,
        systemId: 'com.provenance.nes',
        availability: 'local',
      },
    ],
  });
  const sourceId = catalog.listSources(root.id)[0]?.id;
  assert.ok(sourceId);
  const oldBytes = Buffer.from('generated original cover');
  const record: SourceMatchRecord = {
    id: sameCandidate ? 'artwork-candidate' : 'old-cover',
    providerId: 'org.example.catalog',
    kind: 'artwork',
    title: 'Original cover',
    confidence: 'local',
    metadata: { artworkRole: 'front' },
    originKind: null,
    contentAvailable: true,
    contentType: 'image/png',
    fileName: 'cover.png',
    updatedAt: '2030-01-01T00:00:00Z',
  };
  catalog.saveSourceMatch(sourceId, 0, 'artwork', record, oldBytes, userId);
  const before = catalog.sourceMatches(sourceId);
  const host = catalog.workflowIdentities.createHost(
    userId,
    'Host',
    'a'.repeat(64),
    Date.now() + 600_000,
  );
  const run = catalog.workflowRuns.createRun(
    {
      hostId: host.id,
      workflowId: 'org.ecs.library-cleanup',
      workflowDigest: 'b'.repeat(64),
      scope: { libraryId: library.id },
      options: { online: false, checksum: false, shareImages: false },
    },
    userId,
  );
  const currentValueDigest = workflowDigest(before),
    sourceValidator = 'a'.repeat(64);
  const metadataFinding = catalog.workflowProposals.addFinding(run.id, {
    sourceId,
    kind: 'suspected-mismatch',
    ruleVersion: 'cleanup/1',
    currentValueDigest,
    evidenceDigest: 'c'.repeat(64),
    evidenceIds: [],
    reason: 'Generated metadata',
  });
  const artFinding = catalog.workflowProposals.addFinding(run.id, {
    sourceId,
    kind: 'questionable-front-artwork',
    ruleVersion: 'cleanup/1',
    currentValueDigest,
    evidenceDigest: 'd'.repeat(64),
    evidenceIds: [],
    reason: 'Generated cover',
  });
  const newBytes = Buffer.from('generated proposed cover');
  const artifact = {
    id: 'artifact-1',
    runId: run.id,
    sourceId,
    sha256: createHash('sha256').update(newBytes).digest('hex'),
    size: newBytes.length,
    contentType: 'image/png',
    width: 2,
    height: 2,
    attributionJson: '{}',
    expiresAt: null,
  };
  catalog.workflowProposals.stageArtifact(artifact, newBytes, 'staging:art');
  const common = {
    runId: run.id,
    sourceId,
    sourceValidator,
    selectionRevision: before.revision,
    currentValueDigest,
    evidenceIds: [],
    reason: 'Generated fix',
  };
  const metadata = catalog.workflowProposals.saveProposal({
    ...common,
    id: 'metadata-proposal',
    findingId: metadataFinding.id,
    change: {
      action: 'replace-metadata',
      candidateId: 'metadata-candidate',
      artifactId: null,
      snapshotJson: JSON.stringify({
        ...record,
        id: 'metadata-candidate',
        kind: 'metadata',
        title: 'Corrected details',
        metadata: { systemId: 'com.provenance.nes' },
        contentAvailable: false,
        contentType: null,
        fileName: null,
      }),
    },
  });
  const artwork = catalog.workflowProposals.saveProposal({
    ...common,
    id: 'artwork-proposal',
    findingId: artFinding.id,
    change: {
      action: 'replace-front-artwork',
      candidateId: 'artwork-candidate',
      artifactId: artifact.id,
      snapshotJson: JSON.stringify({
        ...record,
        id: 'artwork-candidate',
        title: 'Corrected cover',
      }),
    },
  });
  const versions = [metadata, artwork].map(({ id, version, digest }) => ({ id, version, digest }));
  return {
    catalog,
    path,
    userId,
    root,
    sourceId,
    run,
    versions,
    metadata,
    artwork,
    before,
    oldBytes,
    newBytes,
    sourceValidator,
    async close() {
      catalog.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('approval binds exact versions and rejects changed proposals, keys and mutually exclusive alternatives', async () => {
  const f = await fixture();
  try {
    const revision = f.catalog.workflowRuns.getRun(f.run.id)?.revision;
    assert.ok(revision);
    const approval = f.catalog.workflowApplications.approveWorkflowBatch(
      f.run.id,
      revision,
      f.versions,
      f.userId,
      'approval-key-1',
    );
    assert.deepEqual(
      f.catalog.workflowApplications.approveWorkflowBatch(
        f.run.id,
        revision,
        f.versions,
        f.userId,
        'approval-key-1',
      ),
      approval,
    );
    assert.throws(() =>
      f.catalog.workflowApplications.approveWorkflowBatch(
        f.run.id,
        revision,
        f.versions.slice(0, 1),
        f.userId,
        'approval-key-1',
      ),
    );
    const { version: _version, digest: _digest, ...draft } = f.metadata;
    const alternative = f.catalog.workflowProposals.saveProposal({
      ...draft,
      id: 'alternative-metadata',
    });
    const current = f.catalog.workflowRuns.getRun(f.run.id)?.revision;
    assert.ok(current);
    const firstVersion = f.versions[0];
    assert.ok(firstVersion);
    assert.throws(() =>
      f.catalog.workflowApplications.approveWorkflowBatch(
        f.run.id,
        current,
        [
          firstVersion,
          { id: alternative.id, version: alternative.version, digest: alternative.digest },
        ],
        f.userId,
        'approval-key-2',
      ),
    );
    f.catalog.workflowProposals.saveProposal({ ...draft, reason: 'New evidence requires review' });
    f.catalog.workflowApplications.beginApplication(approval.id, 'application-1', f.userId);
    assert.throws(() =>
      f.catalog.workflowApplications.applySourceProposalGroup({
        approvalId: approval.id,
        applicationId: 'application-1',
        sourceId: f.sourceId,
        actorId: f.userId,
        sourceValidator: f.sourceValidator,
      }),
    );
    assert.deepEqual(f.catalog.sourceMatches(f.sourceId), f.before);
  } finally {
    await f.close();
  }
});

test('slot updates, audit and receipt commit together; retries preserve subsequent manual edits', async () => {
  const f = await fixture();
  const raw = new DatabaseSync(f.path);
  try {
    const revision = f.catalog.workflowRuns.getRun(f.run.id)?.revision;
    assert.ok(revision);
    const approval = f.catalog.workflowApplications.approveWorkflowBatch(
      f.run.id,
      revision,
      f.versions,
      f.userId,
      'approval-key-1',
    );
    f.catalog.workflowApplications.beginApplication(approval.id, 'application-1', f.userId);
    const input = {
      approvalId: approval.id,
      applicationId: 'application-1',
      sourceId: f.sourceId,
      actorId: f.userId,
      sourceValidator: f.sourceValidator,
    };
    raw.exec(
      "CREATE TRIGGER generated_apply_failure BEFORE INSERT ON source_match_selections WHEN NEW.kind='artwork' BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM source_match_selections WHERE source_id=NEW.source_id AND kind='metadata') THEN RAISE(ABORT,'generated-failure') ELSE RAISE(ABORT,'not-between-updates') END; END;",
    );
    assert.throws(
      () => f.catalog.workflowApplications.applySourceProposalGroup(input),
      /generated-failure/,
    );
    assert.deepEqual(f.catalog.sourceMatches(f.sourceId), f.before);
    assert.equal(f.catalog.workflowApplications.getApplication('application-1', f.sourceId), null);
    raw.exec('DROP TRIGGER generated_apply_failure');
    const receipt = f.catalog.workflowApplications.applySourceProposalGroup(input);
    assert.equal(receipt.status, 'applied');
    assert.equal(receipt.afterRevision, f.before.revision + 2);
    assert.deepEqual(
      Buffer.from(f.catalog.sourceMatchContent(f.sourceId, 'artwork') ?? []),
      f.newBytes,
    );
    assert.deepEqual(f.catalog.workflowApplications.applySourceProposalGroup(input), receipt);
    const current = f.catalog.sourceMatches(f.sourceId);
    const saved = current.matches.find((m) => m.kind === 'metadata');
    assert.ok(saved);
    const edited = f.catalog.saveSourceMatch(
      f.sourceId,
      current.revision,
      'metadata',
      { ...saved, id: 'manual-edit', title: 'Later manual choice' },
      null,
      f.userId,
    );
    assert.deepEqual(f.catalog.workflowApplications.applySourceProposalGroup(input), receipt);
    assert.deepEqual(f.catalog.sourceMatches(f.sourceId), edited);
    assert.throws(() =>
      f.catalog.workflowApplications.undoWorkflowApplication('application-1', f.sourceId, f.userId),
    );
    assert.equal(
      (
        raw
          .prepare("SELECT count(*) AS n FROM audit_events WHERE action='apply-workflow-cleanup'")
          .get() as { n: number }
      ).n,
      1,
    );
  } finally {
    raw.close();
    await f.close();
  }
});

test('undo restores exact prior artwork and metadata conditionally, with expiry and idempotent receipts', async () => {
  const f = await fixture();
  try {
    const revision = f.catalog.workflowRuns.getRun(f.run.id)?.revision;
    assert.ok(revision);
    const approval = f.catalog.workflowApplications.approveWorkflowBatch(
      f.run.id,
      revision,
      f.versions,
      f.userId,
      'approval-key-1',
    );
    f.catalog.workflowApplications.beginApplication(approval.id, 'application-1', f.userId);
    f.catalog.workflowApplications.applySourceProposalGroup({
      approvalId: approval.id,
      applicationId: 'application-1',
      sourceId: f.sourceId,
      actorId: f.userId,
      sourceValidator: f.sourceValidator,
    });
    assert.throws(() =>
      f.catalog.workflowApplications.undoWorkflowApplication(
        'application-1',
        f.sourceId,
        f.userId,
        Date.now() + 31 * 86400_000,
      ),
    );
    const undone = f.catalog.workflowApplications.undoWorkflowApplication(
      'application-1',
      f.sourceId,
      f.userId,
    );
    assert.equal(undone.status, 'undone');
    assert.deepEqual(f.catalog.sourceMatches(f.sourceId).matches, f.before.matches);
    assert.deepEqual(
      Buffer.from(f.catalog.sourceMatchContent(f.sourceId, 'artwork') ?? []),
      f.oldBytes,
    );
    assert.deepEqual(
      f.catalog.workflowApplications.undoWorkflowApplication('application-1', f.sourceId, f.userId),
      undone,
    );
  } finally {
    await f.close();
  }
});

test('an artwork candidate retaining its catalog ID still replaces the exact approved image bytes', async () => {
  const f = await fixture(true);
  try {
    const revision = f.catalog.workflowRuns.getRun(f.run.id)?.revision;
    assert.ok(revision);
    const approval = f.catalog.workflowApplications.approveWorkflowBatch(
      f.run.id,
      revision,
      f.versions,
      f.userId,
      'stable-candidate-approval',
    );
    f.catalog.workflowApplications.beginApplication(
      approval.id,
      'stable-candidate-application',
      f.userId,
    );
    f.catalog.workflowApplications.applySourceProposalGroup({
      approvalId: approval.id,
      applicationId: 'stable-candidate-application',
      sourceId: f.sourceId,
      actorId: f.userId,
      sourceValidator: f.sourceValidator,
    });
    assert.deepEqual(
      Buffer.from(f.catalog.sourceMatchContent(f.sourceId, 'artwork') ?? []),
      f.newBytes,
    );
    assert.equal(
      f.catalog.sourceMatches(f.sourceId).matches.find((m) => m.kind === 'artwork')?.title,
      'Corrected cover',
    );
  } finally {
    await f.close();
  }
});

test('assigning an unassigned folder changes the frozen workflow scope and blocks application', async () => {
  const f = await fixture();
  try {
    const root = f.catalog.createContentRoot({
      path: join(f.root.path, '..', 'unassigned'),
      label: 'Unassigned',
      libraryId: null,
      actorId: f.userId,
    });
    f.catalog.applyInspection({
      rootId: root.id,
      actorId: f.userId,
      online: true,
      files: [
        {
          relativePath: 'Other.nes',
          displayName: 'Other.nes',
          kind: 'rom',
          size: 4,
          blocks: 1,
          systemId: 'com.provenance.nes',
          availability: 'local',
        },
      ],
    });
    const sourceId = f.catalog.listSources(root.id)[0]?.id;
    assert.ok(sourceId);
    const run = f.catalog.workflowRuns.createRun(
      { ...f.run, scope: { unassigned: true, rootId: root.id } },
      f.userId,
    );
    const before = f.catalog.sourceMatches(sourceId),
      currentValueDigest = workflowDigest(before);
    const finding = f.catalog.workflowProposals.addFinding(run.id, {
      sourceId,
      kind: 'suspected-mismatch',
      ruleVersion: 'cleanup/1',
      currentValueDigest,
      evidenceDigest: 'a'.repeat(64),
      evidenceIds: [],
      reason: 'Generated details',
    });
    const proposal = f.catalog.workflowProposals.saveProposal({
      id: 'unassigned-metadata',
      runId: run.id,
      sourceId,
      findingId: finding.id,
      sourceValidator: f.sourceValidator,
      selectionRevision: 0,
      currentValueDigest,
      change: f.metadata.change,
      evidenceIds: [],
      reason: 'Generated details',
    });
    const revision = f.catalog.workflowRuns.getRun(run.id)?.revision;
    assert.ok(revision);
    const approval = f.catalog.workflowApplications.approveWorkflowBatch(
      run.id,
      revision,
      [{ id: proposal.id, version: proposal.version, digest: proposal.digest }],
      f.userId,
      'assignment-approval',
    );
    f.catalog.workflowApplications.beginApplication(
      approval.id,
      'assignment-application',
      f.userId,
    );
    f.catalog.assignUnassignedRoot({
      rootId: root.id,
      libraryId: f.run.scope.libraryId ?? '',
      actorId: f.userId,
      deviceId: null,
    });
    assert.equal(f.catalog.workflowRuns.sourceIsCurrent(run.id, sourceId), false);
    assert.throws(() =>
      f.catalog.workflowApplications.applySourceProposalGroup({
        approvalId: approval.id,
        applicationId: 'assignment-application',
        sourceId,
        actorId: f.userId,
        sourceValidator: f.sourceValidator,
      }),
    );
    assert.deepEqual(f.catalog.sourceMatches(sourceId), before);
    assert.deepEqual(f.catalog.sourceMatches(f.sourceId), f.before);
  } finally {
    await f.close();
  }
});
