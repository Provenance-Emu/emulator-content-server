import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CatalogDatabase } from '../src/catalog.js';
import { WorkflowProposalRepository } from '../src/workflow-proposals.js';

test('proposal versions are immutable, paged and survive catalog restart; artifact quotas preserve prior review data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-proposal-records-'));
  const path = join(dir, 'catalog.sqlite');
  let catalog = new CatalogDatabase(path);
  try {
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
      path: join(dir, 'files'),
      label: 'Files',
      libraryId: library.id,
      actorId: userId,
    });
    catalog.applyInspection({
      rootId: root.id,
      actorId: userId,
      online: true,
      files: Array.from({ length: 3 }, (_, index) => ({
        relativePath: `Game-${index}.nes`,
        displayName: `Game-${index}.nes`,
        kind: 'rom',
        size: 4,
        blocks: 1,
        systemId: 'com.provenance.nes',
        availability: 'local' as const,
      })),
    });
    const host = catalog.workflowIdentities.createHost(userId, 'Host', 'a'.repeat(64), 600_000);
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
    const sourceId = catalog.workflowRuns.pageWork(run.id).items[0]?.sourceId;
    assert.ok(sourceId);
    const finding = catalog.workflowProposals.addFinding(run.id, {
      sourceId,
      kind: 'missing-front-artwork',
      ruleVersion: 'cleanup/1',
      currentValueDigest: 'c'.repeat(64),
      evidenceDigest: 'd'.repeat(64),
      evidenceIds: [],
      reason: 'Missing cover',
    });
    const draft = {
      id: 'proposal-1',
      runId: run.id,
      findingId: finding.id,
      sourceId,
      sourceValidator: 'e'.repeat(64),
      selectionRevision: 0,
      currentValueDigest: 'c'.repeat(64),
      change: {
        action: 'replace-metadata' as const,
        candidateId: 'candidate-1',
        artifactId: null,
        snapshotJson: '{"title":"Generated"}',
      },
      evidenceIds: [],
      reason: 'Generated metadata',
    };
    const first = catalog.workflowProposals.saveProposal(draft);
    assert.equal(first.version, 1);
    assert.deepEqual(catalog.workflowProposals.saveProposal(draft), first);
    const second = catalog.workflowProposals.saveProposal({ ...draft, reason: 'Updated evidence' });
    assert.equal(second.version, 2);
    assert.deepEqual(catalog.workflowProposals.getProposal(first.id, 1), first);
    assert.equal(catalog.workflowProposals.pageProposals(run.id).items[0]?.version, 2);
    for (const [sourceIndex, source] of catalog.workflowRuns.pageWork(run.id).items.entries()) {
      const entry =
        source.sourceId === sourceId
          ? finding
          : catalog.workflowProposals.addFinding(run.id, {
              sourceId: source.sourceId,
              kind: 'suspected-mismatch',
              ruleVersion: 'cleanup/1',
              currentValueDigest: 'c'.repeat(64),
              evidenceDigest: 'd'.repeat(64),
              evidenceIds: [],
              reason: 'Generated details',
            });
      for (let index = 0; index < (source.sourceId === sourceId ? 9 : 10); index++)
        catalog.workflowProposals.saveProposal({
          ...draft,
          id: `extra-proposal-${sourceIndex}-${index}`,
          sourceId: source.sourceId,
          findingId: entry.id,
        });
    }
    const page = catalog.workflowProposals.pageProposals(run.id, undefined, 20);
    assert.equal(page.items.length, 20);
    assert.ok(page.nextCursor);
    assert.equal(
      catalog.workflowProposals.pageProposals(run.id, page.nextCursor, 20).items.length,
      10,
    );
    assert.equal(catalog.workflowProposals.pageProposals(run.id, undefined, 100).items.length, 30);
    assert.throws(() => catalog.workflowProposals.pageProposals(run.id, undefined, 101));
    assert.throws(() => catalog.workflowProposals.saveProposal({ ...draft, id: 'over-capacity' }));
    const raw = new DatabaseSync(path);
    const limited = new WorkflowProposalRepository(raw, {
      runBytes: 6,
      libraryBytes: 12,
      serverBytes: 20,
    });
    const bytes = Buffer.from('test');
    const artifact = {
      id: 'artifact-1',
      runId: run.id,
      sourceId,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      contentType: 'image/png',
      width: 2,
      height: 2,
      attributionJson: '{"providerId":"org.example.catalog"}',
      expiresAt: null,
    };
    try {
      limited.stageArtifact(artifact, bytes, 'staging:proposal-1');
      assert.deepEqual(
        Buffer.from(limited.getArtifact(run.id, sourceId, artifact.id)?.bytes ?? []),
        bytes,
      );
      assert.equal(limited.getArtifact('another-run', sourceId, artifact.id), null);
      assert.throws(() =>
        limited.stageArtifact({ ...artifact, id: 'artifact-2' }, bytes, 'staging:proposal-2'),
      );
      assert.ok(limited.getArtifact(run.id, sourceId, artifact.id));
      assert.throws(() =>
        limited.stageArtifact(
          { ...artifact, id: 'bad-digest', sha256: '0'.repeat(64) },
          bytes,
          'staging:bad',
        ),
      );
    } finally {
      raw.close();
    }
    catalog.close();
    catalog = new CatalogDatabase(path);
    assert.deepEqual(catalog.workflowProposals.getProposal(first.id, 1), first);
    assert.ok(catalog.workflowProposals.getArtifact(run.id, sourceId, artifact.id));
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});
