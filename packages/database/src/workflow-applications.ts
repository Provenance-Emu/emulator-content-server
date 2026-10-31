import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  SourceMatchRecord,
  WorkflowApplication,
  WorkflowApproval,
  WorkflowPage,
  WorkflowProposal,
} from '@ecs/domain';
import { sourceMatchContent, sourceMatches, writeSourceMatch } from './source-matches.js';
import {
  requireWorkflowOwner,
  workflowDigest,
  workflowError,
  workflowJson,
  workflowPageLimit,
  workflowTransaction,
} from './workflow-data.js';
import type { WorkflowProposalRepository } from './workflow-proposals.js';
import type { WorkflowRunRepository } from './workflow-runs.js';

export interface WorkflowProposalVersion {
  id: string;
  version: number;
  digest: string;
}
export interface ApplySourceProposalGroup {
  approvalId: string;
  applicationId: string;
  sourceId: string;
  actorId: string;
  sourceValidator: string;
  now?: number;
}
type Mutation = (
  sourceId: string,
  actorId: string,
  action: string,
  detail: Record<string, string>,
) => void;
interface BeforeSlot {
  kind: string;
  role: string;
  selection: SourceMatchRecord | null;
}
interface BeforeState {
  slots: BeforeSlot[];
  artifactIds: string[];
}
function slot(proposal: WorkflowProposal): { kind: 'metadata' | 'rom' | 'artwork'; role: string } {
  return proposal.change.action === 'replace-front-artwork'
    ? { kind: 'artwork', role: 'front' }
    : proposal.change.action === 'replace-system'
      ? { kind: 'rom', role: '' }
      : { kind: 'metadata', role: '' };
}
function snapshot(proposal: WorkflowProposal): SourceMatchRecord {
  const result = JSON.parse(proposal.change.snapshotJson) as SourceMatchRecord;
  const target = slot(proposal);
  if (
    !result ||
    typeof result !== 'object' ||
    result.kind !== target.kind ||
    result.id !== proposal.change.candidateId ||
    typeof result.title !== 'string' ||
    typeof result.providerId !== 'string' ||
    !['checksum', 'local', 'name'].includes(result.confidence) ||
    !result.metadata ||
    typeof result.metadata !== 'object' ||
    Array.isArray(result.metadata) ||
    Object.values(result.metadata).some((value) => typeof value !== 'string') ||
    (target.kind === 'artwork' &&
      (result.artworkRole ?? result.metadata.artworkRole ?? 'front') !== 'front')
  )
    workflowError('workflow-proposal-conflict');
  return result;
}

export class WorkflowApplicationRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly proposals: WorkflowProposalRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly mutation: Mutation,
  ) {}
  getApproval(id: string): WorkflowApproval | null {
    const row = this.db
      .prepare('SELECT approval_json FROM workflow_approvals WHERE id=?')
      .get(id) as { approval_json: string } | undefined;
    return row ? (JSON.parse(row.approval_json) as WorkflowApproval) : null;
  }
  approveWorkflowBatch(
    runId: string,
    expectedRevision: number,
    versions: WorkflowProposalVersion[],
    actorId: string,
    requestKey: string,
    now = Date.now(),
  ): WorkflowApproval {
    requireWorkflowOwner(this.db, actorId);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1 ||
      !Array.isArray(versions) ||
      versions.length < 1 ||
      versions.length > 100 ||
      !/^[A-Za-z0-9._:-]{8,200}$/.test(requestKey) ||
      versions.some(
        (v) =>
          !v ||
          typeof v.id !== 'string' ||
          v.id.length > 200 ||
          !Number.isSafeInteger(v.version) ||
          v.version < 1 ||
          !/^[a-f0-9]{64}$/.test(v.digest),
      ) ||
      new Set(versions.map((v) => v.id)).size !== versions.length
    )
      workflowError('invalid-request', 400);
    const sorted = versions
      .map((v) => ({ id: v.id, version: v.version, digest: v.digest }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const digest = workflowDigest([runId, expectedRevision, sorted]);
    return workflowTransaction(this.db, () => {
      const existing = this.db
        .prepare(
          'SELECT approval_json,digest FROM workflow_approvals WHERE actor_id=? AND request_key=?',
        )
        .get(actorId, requestKey) as { approval_json: string; digest: string } | undefined;
      if (existing) {
        if (existing.digest !== digest) workflowError('workflow-approval-conflict');
        return JSON.parse(existing.approval_json) as WorkflowApproval;
      }
      const run = this.runs.getRun(runId);
      if (!run) workflowError('not-found', 404);
      if (run.revision !== expectedRevision) workflowError('workflow-review-changed');
      const targets = new Set<string>();
      for (const version of sorted) {
        const proposal = this.proposals.getProposal(version.id);
        if (
          !proposal ||
          proposal.runId !== runId ||
          proposal.version !== version.version ||
          proposal.digest !== version.digest
        )
          workflowError('workflow-proposal-conflict');
        const finding = this.proposals.getFinding(proposal.findingId);
        if (!finding || this.proposals.isDismissed(finding))
          workflowError('workflow-finding-dismissed');
        const target = slot(proposal),
          key = JSON.stringify([proposal.sourceId, target.kind, target.role]);
        if (targets.has(key)) workflowError('workflow-alternative-conflict');
        targets.add(key);
        snapshot(proposal);
      }
      const approval: WorkflowApproval = {
        id: randomUUID(),
        runId,
        actorId,
        runRevision: expectedRevision,
        proposalVersionsJson: workflowJson(sorted, 64 * 1024),
        digest,
        createdAt: new Date(now).toISOString(),
      };
      this.db
        .prepare(
          'INSERT INTO workflow_approvals(id,run_id,actor_id,approval_json,request_key,digest) VALUES(?,?,?,?,?,?)',
        )
        .run(approval.id, runId, actorId, workflowJson(approval), requestKey, digest);
      return approval;
    });
  }
  private ownedApproval(id: string, actorId: string): WorkflowApproval {
    requireWorkflowOwner(this.db, actorId);
    const approval = this.getApproval(id);
    if (!approval) workflowError('not-found', 404);
    if (approval.actorId !== actorId) workflowError('forbidden', 403);
    return approval;
  }
  beginApplication(approvalId: string, applicationId: string, actorId: string): WorkflowApproval {
    const approval = this.ownedApproval(approvalId, actorId);
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(applicationId)) workflowError('invalid-request', 400);
    workflowTransaction(this.db, () => {
      const row = this.db
        .prepare('SELECT approval_id,actor_id FROM workflow_application_batches WHERE id=?')
        .get(applicationId) as { approval_id: string; actor_id: string } | undefined;
      if (row) {
        if (row.approval_id !== approvalId || row.actor_id !== actorId)
          workflowError('workflow-application-conflict');
        return;
      }
      this.db
        .prepare(
          'INSERT INTO workflow_application_batches(id,approval_id,actor_id,created_at) VALUES(?,?,?,?)',
        )
        .run(applicationId, approvalId, actorId, new Date().toISOString());
    });
    return approval;
  }
  getApplication(id: string, sourceId: string): WorkflowApplication | null {
    const row = this.db
      .prepare('SELECT receipt_json FROM workflow_applications WHERE id=? AND source_id=?')
      .get(id, sourceId) as { receipt_json: string } | undefined;
    return row ? (JSON.parse(row.receipt_json) as WorkflowApplication) : null;
  }
  applications(id: string, actorId: string): WorkflowApplication[] {
    requireWorkflowOwner(this.db, actorId);
    const batch = this.db
      .prepare('SELECT actor_id FROM workflow_application_batches WHERE id=?')
      .get(id) as { actor_id: string } | undefined;
    if (!batch || batch.actor_id !== actorId) workflowError('not-found', 404);
    return (
      this.db
        .prepare('SELECT receipt_json FROM workflow_applications WHERE id=? ORDER BY source_id')
        .all(id) as { receipt_json: string }[]
    ).map((row) => JSON.parse(row.receipt_json) as WorkflowApplication);
  }
  runApplications(runId: string, cursor?: string, limit = 20): WorkflowPage<WorkflowApplication> {
    workflowPageLimit(limit);
    let position: [string, string, string] | undefined;
    if (cursor) {
      try {
        if (cursor.length > 2048) throw new Error();
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
        if (
          !Array.isArray(value) ||
          value.length !== 3 ||
          value.some((part) => typeof part !== 'string' || part.length > 200)
        )
          throw new Error();
        position = value as [string, string, string];
      } catch {
        workflowError('invalid-request', 400);
      }
    }
    const rows = this.db
      .prepare(
        'SELECT a.id,a.source_id,a.receipt_json,b.created_at FROM workflow_applications a JOIN workflow_application_batches b ON b.id=a.id JOIN workflow_approvals p ON p.id=a.approval_id WHERE p.run_id=? AND (? IS NULL OR (b.created_at,a.id,a.source_id)<(?,?,?)) ORDER BY b.created_at DESC,a.id DESC,a.source_id DESC LIMIT ?',
      )
      .all(runId, position?.[0] ?? null, ...(position ?? ['', '', '']), limit + 1) as {
      id: string;
      source_id: string;
      receipt_json: string;
      created_at: string;
    }[];
    const last = rows[limit - 1];
    return {
      items: rows.slice(0, limit).map((row) => JSON.parse(row.receipt_json) as WorkflowApplication),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.created_at, last.id, last.source_id])).toString(
              'base64url',
            )
          : null,
    };
  }
  private assertBatch(
    approvalId: string,
    applicationId: string,
    actorId: string,
  ): WorkflowApproval {
    const approval = this.ownedApproval(approvalId, actorId);
    const row = this.db
      .prepare('SELECT approval_id,actor_id FROM workflow_application_batches WHERE id=?')
      .get(applicationId) as { approval_id: string; actor_id: string } | undefined;
    if (!row || row.approval_id !== approvalId || row.actor_id !== actorId)
      workflowError('workflow-application-conflict');
    return approval;
  }
  private approvedProposals(approval: WorkflowApproval, sourceId: string): WorkflowProposal[] {
    const selected = (JSON.parse(approval.proposalVersionsJson) as WorkflowProposalVersion[])
      .map((version) => {
        const exact = this.proposals.getProposal(version.id, version.version);
        if (!exact || exact.runId !== approval.runId || exact.digest !== version.digest)
          workflowError('workflow-proposal-conflict');
        return exact;
      })
      .filter((p) => p.sourceId === sourceId)
      .sort(
        (a, b) =>
          (({ metadata: 0, rom: 1, artwork: 2 })[slot(a).kind] ?? 3) -
          ({ metadata: 0, rom: 1, artwork: 2 }[slot(b).kind] ?? 3),
      );
    if (!selected.length) workflowError('workflow-source-conflict');
    return selected;
  }
  applySourceProposalGroup(input: ApplySourceProposalGroup): WorkflowApplication {
    return workflowTransaction(this.db, () => {
      const approval = this.assertBatch(input.approvalId, input.applicationId, input.actorId);
      const existing = this.getApplication(input.applicationId, input.sourceId);
      if (existing) return existing;
      const proposals = this.approvedProposals(approval, input.sourceId);
      if (!this.runs.sourceIsCurrent(approval.runId, input.sourceId))
        workflowError('workflow-source-conflict');
      const before = sourceMatches(this.db, input.sourceId),
        currentDigest = workflowDigest(before);
      for (const proposal of proposals) {
        const latest = this.proposals.getProposal(proposal.id),
          finding = this.proposals.getFinding(proposal.findingId);
        if (
          latest?.version !== proposal.version ||
          latest.digest !== proposal.digest ||
          !finding ||
          this.proposals.isDismissed(finding) ||
          proposal.sourceValidator !== input.sourceValidator ||
          proposal.selectionRevision !== before.revision ||
          proposal.currentValueDigest !== currentDigest
        )
          workflowError('workflow-selection-changed');
      }
      const slots: BeforeSlot[] = [],
        blobs: { kind: string; role: string; bytes: Uint8Array }[] = [];
      const oldRefs = this.db
        .prepare(
          "SELECT artifact_id FROM workflow_artifact_refs WHERE reference_kind='selected' AND reference_id=?",
        )
        .all(`source:${input.sourceId}:front`) as { artifact_id: string }[];
      let current = before;
      for (const proposal of proposals) {
        const target = slot(proposal),
          record = {
            ...snapshot(proposal),
            id: workflowDigest([
              'cleanup-selection',
              proposal.id,
              proposal.version,
              proposal.digest,
            ]),
          };
        const old =
          before.matches.find(
            (m) =>
              m.kind === target.kind &&
              (target.kind !== 'artwork' ||
                (m.artworkRole ?? m.metadata.artworkRole ?? 'front') === target.role),
          ) ?? null;
        slots.push({ ...target, selection: old });
        const oldBytes = sourceMatchContent(this.db, input.sourceId, target.kind, 'front');
        if (oldBytes) blobs.push({ ...target, bytes: oldBytes });
        let content: Uint8Array | null = null;
        if (target.kind === 'artwork') {
          const artifact =
            proposal.change.artifactId &&
            this.proposals.getArtifact(approval.runId, input.sourceId, proposal.change.artifactId);
          if (
            !artifact ||
            createHash('sha256').update(artifact.bytes).digest('hex') !==
              artifact.artifact.sha256 ||
            artifact.bytes.byteLength !== artifact.artifact.size
          )
            workflowError('workflow-artifact-conflict');
          content = artifact.bytes;
          this.db
            .prepare(
              "DELETE FROM workflow_artifact_refs WHERE reference_kind='selected' AND reference_id=?",
            )
            .run(`source:${input.sourceId}:front`);
        } else if (proposal.change.artifactId) workflowError('workflow-proposal-conflict');
        current = writeSourceMatch(
          this.db,
          input.sourceId,
          current.revision,
          target.kind,
          record,
          content,
          target.kind === 'artwork' ? 'front' : undefined,
        );
        if (proposal.change.artifactId)
          this.db
            .prepare(
              "INSERT OR IGNORE INTO workflow_artifact_refs(artifact_id,run_id,source_id,reference_kind,reference_id) VALUES(?,?,?,'selected',?)",
            )
            .run(
              proposal.change.artifactId,
              approval.runId,
              input.sourceId,
              `source:${input.sourceId}:front`,
            );
      }
      const now = input.now ?? Date.now();
      const receipt: WorkflowApplication = {
        id: input.applicationId,
        approvalId: approval.id,
        sourceId: input.sourceId,
        status: 'applied',
        beforeRevision: before.revision,
        afterRevision: current.revision,
        resultJson: workflowJson({
          proposals: proposals.map(({ id, version, digest }) => ({ id, version, digest })),
          sourceValidator: input.sourceValidator,
        }),
        undoExpiresAt: new Date(now + 30 * 86400_000).toISOString(),
      };
      this.db
        .prepare(
          'INSERT INTO workflow_applications(id,source_id,approval_id,receipt_json,before_json,post_digest,undo_expires_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          receipt.id,
          receipt.sourceId,
          approval.id,
          workflowJson(receipt),
          workflowJson({
            slots,
            artifactIds: oldRefs.map((r) => r.artifact_id),
          } satisfies BeforeState),
          workflowDigest(current),
          receipt.undoExpiresAt,
        );
      for (const blob of blobs)
        this.db
          .prepare(
            'INSERT INTO workflow_undo_blobs(application_id,source_id,kind,artwork_role,content) VALUES(?,?,?,?,?)',
          )
          .run(receipt.id, receipt.sourceId, blob.kind, blob.role, blob.bytes);
      for (const ref of oldRefs)
        this.db
          .prepare(
            "INSERT OR IGNORE INTO workflow_artifact_refs(artifact_id,run_id,source_id,reference_kind,reference_id) VALUES(?,?,?,'undo',?)",
          )
          .run(
            ref.artifact_id,
            approval.runId,
            input.sourceId,
            `${receipt.id}:${receipt.sourceId}`,
          );
      this.mutation(input.sourceId, input.actorId, 'apply-workflow-cleanup', {
        approvalId: approval.id,
        applicationId: receipt.id,
      });
      this.db
        .prepare('UPDATE workflow_runs SET revision=revision+1 WHERE id=?')
        .run(approval.runId);
      return receipt;
    });
  }
  recordConflict(
    approvalId: string,
    applicationId: string,
    sourceId: string,
    actorId: string,
    code: string,
  ): WorkflowApplication {
    return workflowTransaction(this.db, () => {
      const approval = this.assertBatch(approvalId, applicationId, actorId);
      const proposals = this.approvedProposals(approval, sourceId);
      const existing = this.getApplication(applicationId, sourceId);
      if (existing) return existing;
      const revision = sourceMatches(this.db, sourceId).revision;
      const receipt: WorkflowApplication = {
        id: applicationId,
        approvalId,
        sourceId,
        status: 'conflict',
        beforeRevision: revision,
        afterRevision: revision,
        resultJson: workflowJson({
          code,
          proposals: proposals.map(({ id, version, digest }) => ({ id, version, digest })),
        }),
        undoExpiresAt: new Date().toISOString(),
      };
      this.db
        .prepare(
          'INSERT INTO workflow_applications(id,source_id,approval_id,receipt_json,before_json,post_digest,undo_expires_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          applicationId,
          sourceId,
          approval.id,
          workflowJson(receipt),
          '{}',
          '',
          receipt.undoExpiresAt,
        );
      return receipt;
    });
  }
  undoWorkflowApplication(
    applicationId: string,
    sourceId: string,
    actorId: string,
    now = Date.now(),
  ): WorkflowApplication {
    return workflowTransaction(this.db, () => {
      const receipt = this.getApplication(applicationId, sourceId);
      if (!receipt) workflowError('not-found', 404);
      const approval = this.assertBatch(receipt.approvalId, applicationId, actorId);
      if (receipt.status === 'undone') return receipt;
      if (
        receipt.status !== 'applied' ||
        Date.parse(receipt.undoExpiresAt) <= now ||
        !this.runs.sourceIsCurrent(approval.runId, sourceId)
      )
        workflowError('workflow-undo-conflict');
      const row = this.db
        .prepare(
          'SELECT before_json,post_digest FROM workflow_applications WHERE id=? AND source_id=?',
        )
        .get(applicationId, sourceId) as { before_json: string; post_digest: string };
      let current = sourceMatches(this.db, sourceId);
      if (current.revision !== receipt.afterRevision || workflowDigest(current) !== row.post_digest)
        workflowError('workflow-undo-conflict');
      const before = JSON.parse(row.before_json) as BeforeState;
      for (const target of before.slots) {
        const blob = this.db
          .prepare(
            'SELECT content FROM workflow_undo_blobs WHERE application_id=? AND source_id=? AND kind=? AND artwork_role=?',
          )
          .get(applicationId, sourceId, target.kind, target.role) as
          | { content: Uint8Array }
          | undefined;
        current = writeSourceMatch(
          this.db,
          sourceId,
          current.revision,
          target.kind,
          target.selection,
          blob?.content ?? null,
          target.kind === 'artwork' ? 'front' : undefined,
        );
        if (target.kind === 'artwork') {
          this.db
            .prepare(
              "DELETE FROM workflow_artifact_refs WHERE reference_kind='selected' AND reference_id=?",
            )
            .run(`source:${sourceId}:front`);
          for (const artifactId of before.artifactIds)
            this.db
              .prepare(
                "INSERT OR IGNORE INTO workflow_artifact_refs(artifact_id,run_id,source_id,reference_kind,reference_id) VALUES(?,?,?,'selected',?)",
              )
              .run(artifactId, approval.runId, sourceId, `source:${sourceId}:front`);
        }
      }
      const undone: WorkflowApplication = {
        ...receipt,
        status: 'undone',
        resultJson: workflowJson({
          ...JSON.parse(receipt.resultJson),
          undoRevision: current.revision,
        }),
      };
      this.db
        .prepare('UPDATE workflow_applications SET receipt_json=? WHERE id=? AND source_id=?')
        .run(workflowJson(undone), applicationId, sourceId);
      this.mutation(sourceId, actorId, 'undo-workflow-cleanup', {
        approvalId: approval.id,
        applicationId,
      });
      this.db
        .prepare('UPDATE workflow_runs SET revision=revision+1 WHERE id=?')
        .run(approval.runId);
      return undone;
    });
  }
}
