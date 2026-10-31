import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  WorkflowArtifact,
  WorkflowEvidence,
  WorkflowFinding,
  WorkflowFindingDraft,
  WorkflowPage,
  WorkflowProposal,
} from '@ecs/domain';
import {
  requireWorkflowOwner,
  workflowDigest,
  workflowError,
  workflowJson,
  workflowPageLimit,
  workflowTransaction,
} from './workflow-data.js';

export interface WorkflowStagingLimits {
  runBytes: number;
  libraryBytes: number;
  serverBytes: number;
}
export const WORKFLOW_STAGING_LIMITS: WorkflowStagingLimits = {
  runBytes: 64 * 1024 * 1024,
  libraryBytes: 512 * 1024 * 1024,
  serverBytes: 1024 * 1024 * 1024,
};

export class WorkflowProposalRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly stagingLimits: WorkflowStagingLimits = WORKFLOW_STAGING_LIMITS,
  ) {
    if (Object.values(stagingLimits).some((n) => !Number.isSafeInteger(n) || n < 1))
      throw new Error('Invalid workflow staging limits');
  }
  getFinding(id: string): WorkflowFinding | null {
    const row = this.db.prepare('SELECT finding_json FROM workflow_findings WHERE id=?').get(id) as
      | { finding_json: string }
      | undefined;
    return row ? (JSON.parse(row.finding_json) as WorkflowFinding) : null;
  }
  getProposal(id: string, version?: number): WorkflowProposal | null {
    const row = this.db
      .prepare(
        `SELECT proposal_json FROM workflow_proposals WHERE id=? ${version === undefined ? '' : 'AND version=?'} ORDER BY version DESC LIMIT 1`,
      )
      .get(...(version === undefined ? [id] : [id, version])) as
      | { proposal_json: string }
      | undefined;
    return row ? (JSON.parse(row.proposal_json) as WorkflowProposal) : null;
  }
  saveProposal(
    draft: Omit<WorkflowProposal, 'version' | 'digest'>,
    options: { reuseCurrentSnapshot?: boolean } = {},
  ): WorkflowProposal {
    return workflowTransaction(this.db, () => {
      const finding = this.getFinding(draft.findingId);
      if (!finding || finding.runId !== draft.runId || finding.sourceId !== draft.sourceId)
        workflowError('workflow-source-conflict');
      if (
        !['replace-metadata', 'replace-system', 'replace-front-artwork'].includes(
          draft.change.action,
        ) ||
        !draft.reason ||
        draft.reason.length > 4096 ||
        !Number.isSafeInteger(draft.selectionRevision) ||
        draft.selectionRevision < 0 ||
        !/^[a-f0-9]{64}$/.test(draft.sourceValidator) ||
        !/^[a-f0-9]{64}$/.test(draft.currentValueDigest)
      )
        workflowError('invalid-request', 400);
      try {
        workflowJson(JSON.parse(draft.change.snapshotJson), 64 * 1024);
      } catch {
        workflowError('invalid-request', 400);
      }
      for (const id of draft.evidenceIds)
        if (!this.getEvidence(draft.runId, draft.sourceId, id))
          workflowError('workflow-evidence-conflict');
      if (
        draft.change.artifactId &&
        !this.getArtifact(draft.runId, draft.sourceId, draft.change.artifactId)
      )
        workflowError('workflow-artifact-conflict');
      const previous = this.getProposal(draft.id);
      if (previous) {
        if (previous.runId !== draft.runId || previous.sourceId !== draft.sourceId)
          workflowError('workflow-proposal-conflict');
        if (
          options.reuseCurrentSnapshot &&
          previous.sourceValidator === draft.sourceValidator &&
          previous.selectionRevision === draft.selectionRevision &&
          previous.currentValueDigest === draft.currentValueDigest &&
          previous.change.action === draft.change.action &&
          previous.change.candidateId === draft.change.candidateId
        )
          return previous;
        const { version: _version, digest: _digest, ...content } = previous;
        if (workflowDigest(content) === workflowDigest(draft)) return previous;
      } else {
        const count = this.db
          .prepare(
            'SELECT count(DISTINCT id) AS n FROM workflow_proposals WHERE run_id=? AND source_id=?',
          )
          .get(draft.runId, draft.sourceId) as { n: number };
        if (count.n >= 10) workflowError('workflow-capacity', 429);
      }
      const version = (previous?.version ?? 0) + 1;
      const proposal: WorkflowProposal = {
        ...draft,
        version,
        digest: workflowDigest({ ...draft, version }),
      };
      this.db
        .prepare(
          'INSERT INTO workflow_proposals(id,version,run_id,source_id,finding_id,proposal_json,digest) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          proposal.id,
          version,
          draft.runId,
          draft.sourceId,
          draft.findingId,
          workflowJson(proposal),
          proposal.digest,
        );
      if (draft.change.artifactId) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO workflow_artifact_refs(artifact_id,run_id,source_id,reference_kind,reference_id) VALUES(?,?,?,'proposal',?)",
          )
          .run(draft.change.artifactId, draft.runId, draft.sourceId, `${draft.id}:${version}`);
        this.db
          .prepare(
            "DELETE FROM workflow_artifact_refs WHERE artifact_id=? AND reference_kind='proposal' AND reference_id LIKE 'staging:%'",
          )
          .run(draft.change.artifactId);
      }
      this.db.prepare('UPDATE workflow_runs SET revision=revision+1 WHERE id=?').run(draft.runId);
      return proposal;
    });
  }
  getArtifact(
    runId: string,
    sourceId: string,
    id: string,
  ): { artifact: WorkflowArtifact; bytes: Uint8Array } | null {
    const row = this.db
      .prepare(
        'SELECT a.description_json,a.content FROM workflow_artifacts a WHERE a.id=? AND EXISTS(SELECT 1 FROM workflow_artifact_refs r WHERE r.artifact_id=a.id AND r.run_id=? AND r.source_id=?)',
      )
      .get(id, runId, sourceId) as { description_json: string; content: Uint8Array } | undefined;
    return row
      ? { artifact: JSON.parse(row.description_json) as WorkflowArtifact, bytes: row.content }
      : null;
  }
  stageArtifact(
    artifact: WorkflowArtifact,
    bytes: Uint8Array,
    referenceId: string,
  ): WorkflowArtifact {
    if (
      bytes.byteLength > 2 * 1024 * 1024 ||
      bytes.byteLength !== artifact.size ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256 ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(artifact.contentType) ||
      !Number.isSafeInteger(artifact.width) ||
      !Number.isSafeInteger(artifact.height) ||
      artifact.width < 1 ||
      artifact.height < 1 ||
      artifact.width > 16384 ||
      artifact.height > 16384 ||
      artifact.width * artifact.height > 40_000_000
    )
      workflowError('invalid-request', 400);
    return workflowTransaction(this.db, () => {
      if (
        !this.db
          .prepare('SELECT 1 FROM workflow_work WHERE run_id=? AND source_id=?')
          .get(artifact.runId, artifact.sourceId)
      )
        workflowError('workflow-source-conflict');
      const existing = this.db
        .prepare('SELECT description_json FROM workflow_artifacts WHERE id=?')
        .get(artifact.id) as { description_json: string } | undefined;
      if (
        existing &&
        workflowDigest(JSON.parse(existing.description_json)) !== workflowDigest(artifact)
      )
        workflowError('workflow-artifact-conflict');
      if (!existing) {
        const base =
          "SELECT COALESCE(sum(length(a.content)),0) AS n FROM workflow_artifacts a WHERE NOT EXISTS(SELECT 1 FROM workflow_artifact_refs selected WHERE selected.artifact_id=a.id AND selected.reference_kind='selected')";
        const server = this.db.prepare(base).get() as { n: number };
        const run = this.db
          .prepare(
            `${base} AND EXISTS(SELECT 1 FROM workflow_artifact_refs r WHERE r.artifact_id=a.id AND r.run_id=?)`,
          )
          .get(artifact.runId) as { n: number };
        const library = this.db
          .prepare(
            `${base} AND EXISTS(SELECT 1 FROM workflow_artifact_refs r JOIN source_files s ON s.id=r.source_id JOIN content_roots roots ON roots.id=s.root_id WHERE r.artifact_id=a.id AND roots.library_id IS (SELECT cr.library_id FROM source_files sf JOIN content_roots cr ON cr.id=sf.root_id WHERE sf.id=?))`,
          )
          .get(artifact.sourceId) as { n: number };
        if (
          run.n + bytes.byteLength > this.stagingLimits.runBytes ||
          library.n + bytes.byteLength > this.stagingLimits.libraryBytes ||
          server.n + bytes.byteLength > this.stagingLimits.serverBytes
        )
          workflowError('workflow-capacity', 429);
        this.db
          .prepare(
            'INSERT INTO workflow_artifacts(id,sha256,content,description_json,created_at,expires_at) VALUES(?,?,?,?,?,?)',
          )
          .run(
            artifact.id,
            artifact.sha256,
            bytes,
            workflowJson(artifact, 64 * 1024),
            new Date().toISOString(),
            artifact.expiresAt,
          );
      }
      this.db
        .prepare(
          "INSERT OR IGNORE INTO workflow_artifact_refs(artifact_id,run_id,source_id,reference_kind,reference_id) VALUES(?,?,?,'proposal',?)",
        )
        .run(artifact.id, artifact.runId, artifact.sourceId, referenceId);
      return artifact;
    });
  }
  recordEvidence(evidence: WorkflowEvidence): WorkflowEvidence {
    if (
      !this.db
        .prepare('SELECT 1 FROM workflow_work WHERE run_id=? AND source_id=?')
        .get(evidence.runId, evidence.sourceId)
    )
      workflowError('workflow-source-conflict');
    const serialized = workflowJson(evidence);
    const existing = this.getEvidence(evidence.runId, evidence.sourceId, evidence.id);
    if (existing) {
      if (workflowDigest(existing) !== workflowDigest(evidence))
        workflowError('workflow-evidence-conflict');
      return existing;
    }
    this.db
      .prepare('INSERT INTO workflow_evidence(id,run_id,source_id,evidence_json) VALUES(?,?,?,?)')
      .run(evidence.id, evidence.runId, evidence.sourceId, serialized);
    return evidence;
  }
  getEvidence(runId: string, sourceId: string, id: string): WorkflowEvidence | null {
    const row = this.db
      .prepare(
        'SELECT evidence_json FROM workflow_evidence WHERE id=? AND run_id=? AND source_id=?',
      )
      .get(id, runId, sourceId) as { evidence_json: string } | undefined;
    return row ? (JSON.parse(row.evidence_json) as WorkflowEvidence) : null;
  }
  sourceEvidence(runId: string, sourceId: string): WorkflowEvidence[] {
    return (
      this.db
        .prepare(
          'SELECT evidence_json FROM workflow_evidence WHERE run_id=? AND source_id=? ORDER BY rowid DESC LIMIT 1000',
        )
        .all(runId, sourceId) as { evidence_json: string }[]
    ).map((row) => JSON.parse(row.evidence_json) as WorkflowEvidence);
  }
  addFinding(runId: string, draft: WorkflowFindingDraft): WorkflowFinding {
    if (
      !this.db
        .prepare('SELECT source_id FROM workflow_work WHERE run_id=? AND source_id=?')
        .get(runId, draft.sourceId)
    )
      workflowError('workflow-source-conflict');
    if (
      ![
        'identity-conflict',
        'suspected-mismatch',
        'missing-front-artwork',
        'questionable-front-artwork',
        'unavailable-selected-artwork',
      ].includes(draft.kind) ||
      !/^[a-f0-9]{64}$/.test(draft.currentValueDigest) ||
      !/^[a-f0-9]{64}$/.test(draft.evidenceDigest) ||
      !draft.reason.trim() ||
      draft.reason.length > 4096 ||
      !draft.ruleVersion ||
      draft.ruleVersion.length > 120 ||
      !Array.isArray(draft.evidenceIds) ||
      draft.evidenceIds.length > 100
    )
      workflowError('invalid-request', 400);
    for (const evidenceId of draft.evidenceIds) {
      if (
        !this.db
          .prepare('SELECT id FROM workflow_evidence WHERE id=? AND run_id=? AND source_id=?')
          .get(evidenceId, runId, draft.sourceId)
      )
        workflowError('workflow-evidence-conflict');
    }
    const fingerprint = workflowDigest([
      draft.sourceId,
      draft.kind,
      draft.ruleVersion,
      draft.currentValueDigest,
      draft.evidenceDigest,
    ]);
    const existing = this.db
      .prepare('SELECT finding_json FROM workflow_findings WHERE run_id=? AND fingerprint=?')
      .get(runId, fingerprint) as { finding_json: string } | undefined;
    if (existing) {
      const finding = JSON.parse(existing.finding_json) as WorkflowFinding;
      return { ...finding, dismissed: this.isDismissed(finding) };
    }
    const finding: WorkflowFinding = {
      id: randomUUID(),
      runId,
      sourceId: draft.sourceId,
      kind: draft.kind,
      ruleVersion: draft.ruleVersion,
      currentValueDigest: draft.currentValueDigest,
      evidenceDigest: draft.evidenceDigest,
      evidenceIds: draft.evidenceIds,
      reason: draft.reason,
      fingerprint,
      dismissed: false,
    };
    this.db
      .prepare(
        'INSERT INTO workflow_findings(id,run_id,source_id,fingerprint,finding_json) VALUES(?,?,?,?,?)',
      )
      .run(finding.id, runId, finding.sourceId, fingerprint, workflowJson(finding));
    this.db.prepare('UPDATE workflow_runs SET revision=revision+1 WHERE id=?').run(runId);
    return { ...finding, dismissed: this.isDismissed(finding) };
  }
  isDismissed(finding: WorkflowFindingDraft): boolean {
    const fingerprint = workflowDigest([
      finding.sourceId,
      finding.kind,
      finding.ruleVersion,
      finding.currentValueDigest,
      finding.evidenceDigest,
    ]);
    return !!this.db
      .prepare(
        'SELECT d.fingerprint FROM workflow_decisions d JOIN users u ON u.id=d.actor_id WHERE d.fingerprint=? AND u.is_owner=1 LIMIT 1',
      )
      .get(fingerprint);
  }
  recordDecision(findingId: string, decision: 'keep' | 'dismiss', actorId: string): void {
    requireWorkflowOwner(this.db, actorId);
    if (!['keep', 'dismiss'].includes(decision)) workflowError('invalid-request', 400);
    const row = this.db
      .prepare('SELECT fingerprint FROM workflow_findings WHERE id=?')
      .get(findingId) as { fingerprint: string } | undefined;
    if (!row) workflowError('not-found', 404);
    this.db
      .prepare(
        'INSERT INTO workflow_decisions(fingerprint,actor_id,decision,created_at) VALUES(?,?,?,?) ON CONFLICT(fingerprint,actor_id) DO UPDATE SET decision=excluded.decision,created_at=excluded.created_at',
      )
      .run(row.fingerprint, actorId, decision, new Date().toISOString());
  }
  pageFindings(runId: string, cursor?: string, limit = 20): WorkflowPage<WorkflowFinding> {
    workflowPageLimit(limit);
    const rows = this.db
      .prepare(
        'SELECT id,finding_json FROM workflow_findings WHERE run_id=? AND id>? ORDER BY id LIMIT ?',
      )
      .all(runId, cursor ?? '', limit + 1) as { id: string; finding_json: string }[];
    return {
      items: rows.slice(0, limit).map((row) => {
        const finding = JSON.parse(row.finding_json) as WorkflowFinding;
        return { ...finding, dismissed: this.isDismissed(finding) };
      }),
      nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
    };
  }
  pageProposals(runId: string, cursor?: string, limit = 20): WorkflowPage<WorkflowProposal> {
    workflowPageLimit(limit);
    const rows = this.db
      .prepare(
        'SELECT p.id,p.proposal_json FROM workflow_proposals p WHERE p.run_id=? AND p.id>? AND p.version=(SELECT max(latest.version) FROM workflow_proposals latest WHERE latest.id=p.id) ORDER BY p.id LIMIT ?',
      )
      .all(runId, cursor ?? '', limit + 1) as { id: string; proposal_json: string }[];
    return {
      items: rows.slice(0, limit).map((row) => JSON.parse(row.proposal_json) as WorkflowProposal),
      nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
    };
  }
}
