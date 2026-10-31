import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  WorkflowLease,
  WorkflowPage,
  WorkflowPublication,
  WorkflowRun,
  WorkflowRunDraft,
  WorkflowSourceSnapshot,
} from '@ecs/domain';
import {
  requireWorkflowHost,
  requireWorkflowOwner,
  workflowDigest,
  workflowError,
  workflowJson,
  workflowPageLimit,
  workflowTransaction,
} from './workflow-data.js';

interface RunRow {
  id: string;
  actor_id: string;
  host_id: string;
  workflow_id: string;
  workflow_digest: string;
  scope_json: string;
  options_json: string;
  state: WorkflowRun['state'];
  revision: number;
  total: number;
  processed: number;
  created_at: string;
  updated_at: string;
  error: string | null;
  fence: number;
  lease_expires: number | null;
  publication_sequence: number;
}
interface WorkRow {
  source_id: string;
  index_validator: string;
  selection_revision: number;
  state: 'pending' | 'completed';
  output_json?: string | null;
}
function record(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    actorId: row.actor_id,
    hostId: row.host_id,
    workflowId: row.workflow_id,
    workflowDigest: row.workflow_digest,
    scope: JSON.parse(row.scope_json),
    options: JSON.parse(row.options_json),
    state: row.state,
    revision: row.revision,
    total: row.total,
    processed: row.processed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
  };
}

export class WorkflowRunRepository {
  constructor(private readonly db: DatabaseSync) {}
  getRun(id: string): WorkflowRun | null {
    const row = this.row(id);
    return row ? record(row) : null;
  }
  private row(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM workflow_runs WHERE id=?').get(id) as unknown as
      | RunRow
      | undefined;
  }
  listRuns(
    limit = 20,
    cursor?: string,
    scope: { libraryId?: string; rootId?: string; unassigned?: boolean } = {},
  ): WorkflowPage<WorkflowRun> {
    workflowPageLimit(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_runs WHERE (? IS NULL OR json_extract(scope_json,'$.libraryId')=? OR EXISTS(SELECT 1 FROM workflow_work w WHERE w.run_id=workflow_runs.id AND w.library_id=?)) AND (?=0 OR json_extract(scope_json,'$.unassigned')=1 OR EXISTS(SELECT 1 FROM workflow_work w WHERE w.run_id=workflow_runs.id AND w.library_id IS NULL)) AND (? IS NULL OR json_extract(scope_json,'$.rootId')=?) AND (? IS NULL OR (created_at,id)<(SELECT created_at,id FROM workflow_runs WHERE id=?)) ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(
        scope.libraryId ?? null,
        scope.libraryId ?? null,
        scope.libraryId ?? null,
        scope.unassigned ? 1 : 0,
        scope.rootId ?? null,
        scope.rootId ?? null,
        cursor ?? null,
        cursor ?? null,
        limit + 1,
      ) as unknown as RunRow[];
    return {
      items: rows.slice(0, limit).map(record),
      nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
    };
  }
  createRun(
    draft: WorkflowRunDraft,
    actorId: string,
    now = Date.now(),
    requestKey?: string,
  ): WorkflowRun {
    requireWorkflowOwner(this.db, actorId);
    if (
      !/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(draft.workflowId) ||
      !/^[a-f0-9]{64}$/.test(draft.workflowDigest)
    )
      workflowError('invalid-request', 400);
    if (
      !this.db
        .prepare('SELECT id FROM workflow_hosts WHERE id=? AND revoked_at IS NULL')
        .get(draft.hostId)
    )
      workflowError('not-found', 404);
    const scope = draft.scope;
    if (
      (!scope.libraryId && !scope.rootId && !scope.unassigned && !scope.sourceIds) ||
      (scope.libraryId && scope.unassigned)
    )
      workflowError('invalid-request', 400);
    const clauses = ["s.kind='rom'", '(s.group_anchor IS NULL OR s.group_anchor=s.relative_path)'];
    const params: SQLInputValue[] = [];
    if (scope.libraryId) {
      if (
        !this.db
          .prepare('SELECT id FROM libraries WHERE id=? AND deleted_at IS NULL')
          .get(scope.libraryId)
      )
        workflowError('not-found', 404);
      clauses.push('r.library_id=?');
      params.push(scope.libraryId);
    }
    if (scope.rootId) {
      if (!this.db.prepare('SELECT id FROM content_roots WHERE id=?').get(scope.rootId))
        workflowError('not-found', 404);
      clauses.push('r.id=?');
      params.push(scope.rootId);
    }
    if (scope.unassigned) clauses.push('r.library_id IS NULL');
    if (scope.sourceIds) {
      if (
        !Array.isArray(scope.sourceIds) ||
        !scope.sourceIds.length ||
        scope.sourceIds.length > 1000 ||
        new Set(scope.sourceIds).size !== scope.sourceIds.length
      )
        workflowError('invalid-request', 400);
      clauses.push(`s.id IN (${scope.sourceIds.map(() => '?').join(',')})`);
      params.push(...scope.sourceIds);
    }
    return workflowTransaction(this.db, () => {
      if (requestKey !== undefined && !/^[A-Za-z0-9._:-]{8,200}$/.test(requestKey))
        workflowError('invalid-request', 400);
      const requestDigest = workflowDigest(draft);
      if (requestKey) {
        const existing = this.db
          .prepare(
            'SELECT request_digest,run_id FROM workflow_run_requests WHERE actor_id=? AND request_key=?',
          )
          .get(actorId, requestKey) as { request_digest: string; run_id: string } | undefined;
        if (existing) {
          if (existing.request_digest !== requestDigest) workflowError('idempotency-conflict');
          return this.getRun(existing.run_id) as WorkflowRun;
        }
      }
      const bindRequest = (run: WorkflowRun): WorkflowRun => {
        if (requestKey)
          this.db
            .prepare(
              'INSERT INTO workflow_run_requests(actor_id,request_key,request_digest,run_id) VALUES(?,?,?,?)',
            )
            .run(actorId, requestKey, requestDigest, run.id);
        return run;
      };
      const id = randomUUID(),
        time = new Date(now).toISOString();
      this.db
        .prepare(
          "INSERT INTO workflow_runs(id,workflow_id,workflow_digest,host_id,actor_id,scope_json,options_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?)",
        )
        .run(
          id,
          draft.workflowId,
          draft.workflowDigest,
          draft.hostId,
          actorId,
          workflowJson(scope),
          workflowJson(draft.options),
          time,
          time,
        );
      this.db
        .prepare(
          `INSERT INTO workflow_work(run_id,source_id,index_validator,selection_revision,library_id) SELECT ?,s.id,ecs_workflow_stamp(s.root_id,s.relative_path,s.size,s.filesystem_identity,s.mtime_ms),COALESCE(ms.revision,0),r.library_id FROM live_source_files s JOIN content_roots r ON r.id=s.root_id LEFT JOIN source_match_state ms ON ms.source_id=s.id WHERE ${clauses.join(' AND ')}`,
        )
        .run(id, ...params);
      const count = this.db
        .prepare('SELECT count(*) AS n FROM workflow_work WHERE run_id=?')
        .get(id) as { n: number };
      if (scope.sourceIds && count.n !== scope.sourceIds.length)
        workflowError('invalid-request', 400);
      const libraries = this.db
        .prepare(
          "SELECT count(DISTINCT COALESCE(r.library_id,'')) AS n FROM workflow_work w JOIN source_files s ON s.id=w.source_id JOIN content_roots r ON r.id=s.root_id WHERE w.run_id=?",
        )
        .get(id) as { n: number };
      if (libraries.n > 1) workflowError('invalid-request', 400);
      const overlapping = this.db
        .prepare(
          "SELECT prior.* FROM workflow_runs prior WHERE prior.id<>? AND prior.state IN ('queued','running','interrupted') AND EXISTS(SELECT 1 FROM workflow_work a JOIN workflow_work b ON a.source_id=b.source_id WHERE a.run_id=prior.id AND b.run_id=?) ORDER BY prior.created_at,prior.id LIMIT 1",
        )
        .get(id, id) as unknown as RunRow | undefined;
      if (overlapping) {
        if (
          overlapping.actor_id !== actorId ||
          overlapping.host_id !== draft.hostId ||
          overlapping.workflow_id !== draft.workflowId ||
          overlapping.workflow_digest !== draft.workflowDigest ||
          workflowDigest(JSON.parse(overlapping.scope_json)) !== workflowDigest(scope) ||
          workflowDigest(JSON.parse(overlapping.options_json)) !== workflowDigest(draft.options)
        )
          workflowError('workflow-scope-conflict');
        this.db.prepare('DELETE FROM workflow_runs WHERE id=?').run(id);
        return bindRequest(record(overlapping));
      }
      this.db.prepare('UPDATE workflow_runs SET total=? WHERE id=?').run(count.n, id);
      return bindRequest(this.getRun(id) as WorkflowRun);
    });
  }
  pageWork(runId: string, cursor?: string, limit = 50): WorkflowPage<WorkflowSourceSnapshot> {
    return this.workPage(runId, cursor, limit, false);
  }
  pagePendingWork(
    runId: string,
    cursor?: string,
    limit = 50,
  ): WorkflowPage<WorkflowSourceSnapshot> {
    return this.workPage(runId, cursor, limit, true);
  }
  sourceSnapshot(runId: string, sourceId: string): WorkflowSourceSnapshot | null {
    const row = this.db
      .prepare(
        'SELECT source_id,index_validator,selection_revision,state,output_json FROM workflow_work WHERE run_id=? AND source_id=?',
      )
      .get(runId, sourceId) as WorkRow | undefined;
    return row
      ? {
          sourceId: row.source_id,
          indexValidator: row.index_validator,
          selectionRevision: row.selection_revision,
          state: row.state,
          ...(row.output_json ? { outputJson: row.output_json } : {}),
        }
      : null;
  }
  sourceIsCurrent(runId: string, sourceId: string): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM workflow_work w JOIN live_source_files s ON s.id=w.source_id JOIN content_roots r ON r.id=s.root_id WHERE w.run_id=? AND w.source_id=? AND w.library_id IS r.library_id AND w.index_validator=ecs_workflow_stamp(s.root_id,s.relative_path,s.size,s.filesystem_identity,s.mtime_ms)',
      )
      .get(runId, sourceId);
  }
  private workPage(
    runId: string,
    cursor: string | undefined,
    limit: number,
    pending: boolean,
  ): WorkflowPage<WorkflowSourceSnapshot> {
    workflowPageLimit(limit);
    const rows = this.db
      .prepare(
        `SELECT source_id,index_validator,selection_revision,state,output_json FROM workflow_work WHERE run_id=? ${pending ? "AND state='pending'" : ''} AND source_id>? ORDER BY source_id LIMIT ?`,
      )
      .all(runId, cursor ?? '', limit + 1) as unknown as WorkRow[];
    return {
      items: rows.slice(0, limit).map((row) => ({
        sourceId: row.source_id,
        indexValidator: row.index_validator,
        selectionRevision: row.selection_revision,
        state: row.state,
        ...(row.output_json ? { outputJson: row.output_json } : {}),
      })),
      nextCursor: rows.length > limit ? (rows[limit - 1]?.source_id ?? null) : null,
    };
  }
  claimRun(hostId: string, now = Date.now()): WorkflowLease | null {
    requireWorkflowHost(this.db, hostId);
    return workflowTransaction(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT * FROM workflow_runs WHERE host_id=? AND state='queued' ORDER BY created_at,id LIMIT 1",
        )
        .get(hostId) as unknown as RunRow | undefined;
      if (!row) return null;
      requireWorkflowOwner(this.db, row.actor_id);
      this.db
        .prepare(
          "UPDATE workflow_runs SET state='running',fence=fence+1,lease_expires=?,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(now + 60_000, new Date(now).toISOString(), row.id);
      return {
        runId: row.id,
        hostId,
        fence: row.fence + 1,
        expiresAt: new Date(now + 60_000).toISOString(),
      };
    });
  }
  heartbeat(lease: WorkflowLease, now = Date.now()): WorkflowLease {
    return workflowTransaction(this.db, () => {
      this.liveLease(lease, now);
      this.db
        .prepare('UPDATE workflow_runs SET lease_expires=? WHERE id=?')
        .run(now + 60_000, lease.runId);
      return { ...lease, expiresAt: new Date(now + 60_000).toISOString() };
    });
  }
  private liveLease(lease: WorkflowLease, now: number): RunRow {
    requireWorkflowHost(this.db, lease.hostId);
    const row = this.row(lease.runId);
    if (
      !row ||
      row.host_id !== lease.hostId ||
      row.fence !== lease.fence ||
      row.state !== 'running' ||
      row.lease_expires === null ||
      row.lease_expires <= now
    )
      workflowError('workflow-lease-conflict');
    requireWorkflowOwner(this.db, row.actor_id);
    return row;
  }
  publish(lease: WorkflowLease, publication: WorkflowPublication, now = Date.now()): WorkflowRun {
    return workflowTransaction(this.db, () => {
      requireWorkflowHost(this.db, lease.hostId);
      const row = this.row(lease.runId);
      if (!row || row.host_id !== lease.hostId || row.fence !== lease.fence)
        workflowError('workflow-lease-conflict');
      requireWorkflowOwner(this.db, row.actor_id);
      workflowJson(publication);
      const digest = workflowDigest(publication);
      const prior = this.db
        .prepare(
          'SELECT digest,response_json,fence FROM workflow_publications WHERE run_id=? AND sequence=?',
        )
        .get(lease.runId, publication.sequence) as
        | { digest: string; response_json: string; fence: number }
        | undefined;
      if (prior) {
        // The current lease may reconcile an earlier lease's committed acknowledgement.
        // The row/fence check above still rejects every old worker before reaching here.
        if (prior.digest !== digest) workflowError('workflow-publication-conflict');
        return JSON.parse(prior.response_json) as WorkflowRun;
      }
      this.liveLease(lease, now);
      if (
        publication.sequence !== row.publication_sequence + 1 ||
        !publication.checkpointRef ||
        publication.checkpointRef.length > 200 ||
        !Array.isArray(publication.completedSourceIds) ||
        publication.completedSourceIds.length > 50 ||
        new Set(publication.completedSourceIds).size !== publication.completedSourceIds.length ||
        (publication.state !== undefined && !['running', 'completed'].includes(publication.state))
      )
        workflowError('invalid-request', 400);
      let completed = 0;
      if (publication.sourceOutputs !== undefined) {
        if (
          !Array.isArray(publication.sourceOutputs) ||
          publication.sourceOutputs.length > 50 ||
          publication.sourceOutputs.some(
            (o) => !o || typeof o !== 'object' || typeof o.sourceId !== 'string',
          ) ||
          new Set(publication.sourceOutputs.map((o) => o.sourceId)).size !==
            publication.sourceOutputs.length
        )
          workflowError('invalid-request', 400);
        for (const output of publication.sourceOutputs) {
          if (
            !output ||
            typeof output.outputJson !== 'string' ||
            !publication.completedSourceIds.includes(output.sourceId) ||
            Buffer.byteLength(output.outputJson) > 64 * 1024
          )
            workflowError('invalid-request', 400);
          try {
            if (workflowJson(JSON.parse(output.outputJson), 64 * 1024) !== output.outputJson)
              workflowError('invalid-request', 400);
          } catch {
            workflowError('invalid-request', 400);
          }
          const existing = this.sourceSnapshot(row.id, output.sourceId);
          if (existing?.state === 'completed' && existing.outputJson !== output.outputJson)
            workflowError('workflow-publication-conflict');
          this.db
            .prepare('UPDATE workflow_work SET output_json=? WHERE run_id=? AND source_id=?')
            .run(output.outputJson, row.id, output.sourceId);
        }
      }
      for (const sourceId of publication.completedSourceIds) {
        if (
          !this.db
            .prepare('SELECT source_id FROM workflow_work WHERE run_id=? AND source_id=?')
            .get(row.id, sourceId)
        )
          workflowError('workflow-source-conflict');
        completed += Number(
          this.db
            .prepare(
              "UPDATE workflow_work SET state='completed' WHERE run_id=? AND source_id=? AND state='pending'",
            )
            .run(row.id, sourceId).changes,
        );
      }
      if (publication.state === 'completed' && row.processed + completed !== row.total)
        workflowError('workflow-incomplete');
      this.db
        .prepare(
          'UPDATE workflow_runs SET state=?,processed=processed+?,publication_sequence=?,checkpoint_ref=?,revision=revision+1,updated_at=? WHERE id=?',
        )
        .run(
          publication.state ?? 'running',
          completed,
          publication.sequence,
          publication.checkpointRef,
          new Date(now).toISOString(),
          row.id,
        );
      const result = this.getRun(row.id) as WorkflowRun;
      this.db
        .prepare(
          'INSERT INTO workflow_publications(run_id,sequence,fence,digest,response_json) VALUES(?,?,?,?,?)',
        )
        .run(row.id, publication.sequence, lease.fence, digest, workflowJson(result));
      return result;
    });
  }
  interrupt(lease: WorkflowLease, recoveryRequired: boolean, now = Date.now()): WorkflowRun {
    return workflowTransaction(this.db, () => {
      this.liveLease(lease, now);
      this.db
        .prepare(
          'UPDATE workflow_runs SET state=?,fence=fence+1,lease_expires=NULL,revision=revision+1,error=?,updated_at=? WHERE id=?',
        )
        .run(
          recoveryRequired ? 'recovery-required' : 'interrupted',
          recoveryRequired
            ? 'Private operation state requires reconciliation before resuming.'
            : 'Workflow host stopped; resume on the same host.',
          new Date(now).toISOString(),
          lease.runId,
        );
      return this.getRun(lease.runId) as WorkflowRun;
    });
  }
  recoverRuns(now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE workflow_runs SET state='interrupted',fence=fence+1,lease_expires=NULL,revision=revision+1,error='Workflow host disconnected; resume on the same host.',updated_at=? WHERE state='running' AND lease_expires<=?",
      )
      .run(new Date(now).toISOString(), now);
  }
  resumeRun(id: string, actorId: string, now = Date.now()): WorkflowRun {
    requireWorkflowOwner(this.db, actorId);
    const changes = this.db
      .prepare(
        "UPDATE workflow_runs SET state='queued',revision=revision+1,error=NULL,updated_at=? WHERE id=? AND state='interrupted'",
      )
      .run(new Date(now).toISOString(), id).changes;
    if (!changes) workflowError('workflow-state-conflict');
    return this.getRun(id) as WorkflowRun;
  }
  cancelRun(id: string, actorId: string, now = Date.now()): WorkflowRun {
    requireWorkflowOwner(this.db, actorId);
    this.db
      .prepare(
        "UPDATE workflow_runs SET state='cancelled',fence=fence+1,lease_expires=NULL,revision=revision+1,updated_at=? WHERE id=? AND state IN ('queued','running','interrupted')",
      )
      .run(new Date(now).toISOString(), id);
    const result = this.getRun(id);
    if (!result) workflowError('not-found', 404);
    return result;
  }
}
