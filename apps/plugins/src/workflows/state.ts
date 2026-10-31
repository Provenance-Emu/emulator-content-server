import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type JsonValue,
  type OperationRequest,
  type OperationResult,
  validateOperationResult,
  validateWorkflowJson,
  validateWorkflowPlan,
  WORKFLOW_LIMITS,
  type WorkflowPlan,
  type WorkflowSnapshot,
} from '@ecs/plugins/workflows';
import type { WorkflowLease, WorkflowPublication } from '@ecs/protocol';

export interface WorkflowOperationInput {
  runId: string;
  sourceId: string;
  stepId: string;
  bindingId: string;
  workflowDigest: string;
  request: OperationRequest;
}
export interface StoredWorkflowOperation extends WorkflowOperationInput {
  state: 'prepared' | 'submitting' | 'pending' | 'completed' | 'failed' | 'uncertain';
  handle?: JsonValue;
  result?: OperationResult;
}
interface OperationRow {
  id: string;
  run_id: string;
  source_id: string;
  step_id: string;
  binding_id: string;
  workflow_digest: string;
  input_digest: string;
  request_json: string;
  state: StoredWorkflowOperation['state'];
  handle_json: string | null;
  result_json: string | null;
  commit_digest: string | null;
  publication_json: string | null;
}

function digest(value: unknown): string {
  function order(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(order);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, order((value as Record<string, unknown>)[key])]),
      );
    return value;
  }
  return createHash('sha256')
    .update(JSON.stringify(order(value)))
    .digest('hex');
}
function json(value: unknown, limit = WORKFLOW_LIMITS.envelope): string {
  validateWorkflowJson(value, limit, true);
  return JSON.stringify(value);
}
function id(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 200)
    throw new Error('Invalid workflow state identifier');
}
function stored(row: OperationRow): StoredWorkflowOperation {
  return {
    runId: row.run_id,
    sourceId: row.source_id,
    stepId: row.step_id,
    bindingId: row.binding_id,
    workflowDigest: row.workflow_digest,
    request: JSON.parse(row.request_json),
    state: row.state,
    ...(row.handle_json === null ? {} : { handle: JSON.parse(row.handle_json) }),
    ...(row.result_json === null
      ? {}
      : { result: validateOperationResult(JSON.parse(row.result_json)) }),
  };
}

export class WorkflowStateStore {
  constructor(private readonly db: DatabaseSync) {}
  close(): void {
    this.db.close();
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  initializeRun(runId: string): void {
    id(runId);
    this.db
      .prepare('INSERT INTO workflow_runs(run_id) VALUES(?) ON CONFLICT(run_id) DO NOTHING')
      .run(runId);
  }
  hasRun(runId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM workflow_runs WHERE run_id=?').get(runId);
  }
  saveLease(lease: WorkflowLease): void {
    if (!this.hasRun(lease.runId)) throw new Error('Workflow run unavailable');
    this.db
      .prepare('UPDATE workflow_runs SET lease_json=? WHERE run_id=?')
      .run(json(lease), lease.runId);
  }
  savedLeases(): WorkflowLease[] {
    return (
      this.db
        .prepare('SELECT lease_json FROM workflow_runs WHERE lease_json IS NOT NULL')
        .all() as { lease_json: string }[]
    ).map((row) => JSON.parse(row.lease_json) as WorkflowLease);
  }
  runFinished(runId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM workflow_runs WHERE run_id=? AND finished=1')
      .get(runId);
  }
  sourceCompleted(runId: string, sourceId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM workflow_sources WHERE run_id=? AND source_id=? AND complete=1')
      .get(runId, sourceId);
  }
  pendingPlan(runId: string, sourceId: string): WorkflowPlan | null {
    const row = this.db
      .prepare('SELECT plan_json FROM workflow_sources WHERE run_id=? AND source_id=?')
      .get(runId, sourceId) as { plan_json: string | null } | undefined;
    return row?.plan_json ? validateWorkflowPlan(JSON.parse(row.plan_json)) : null;
  }
  savePlan(runId: string, sourceId: string, plan: WorkflowPlan): void {
    validateWorkflowPlan(plan);
    const existing = this.pendingPlan(runId, sourceId);
    if (existing) {
      if (digest(existing) !== digest(plan)) throw new Error('Pending workflow plan changed');
      return;
    }
    const result = this.db
      .prepare(
        'UPDATE workflow_sources SET plan_json=?,advance_count=advance_count+1 WHERE run_id=? AND source_id=? AND complete=0 AND advance_count<256',
      )
      .run(json(plan), runId, sourceId);
    if (!result.changes) throw new Error('Workflow advance limit reached or source unavailable');
  }
  finishPlan(runId: string, sourceId: string): void {
    this.transaction(() => {
      const plan = this.pendingPlan(runId, sourceId);
      if (plan?.state !== 'waiting') throw new Error('No waiting workflow plan');
      const completed = this.resumeSnapshot(runId, sourceId)?.completed ?? {};
      if (plan.operations.some((step) => !Object.hasOwn(completed, step.id)))
        throw new Error('Workflow operations are incomplete');
      this.db
        .prepare(
          'UPDATE workflow_sources SET plan_json=NULL,checkpoint_json=? WHERE run_id=? AND source_id=?',
        )
        .run(json(plan.checkpoint, WORKFLOW_LIMITS.checkpoint), runId, sourceId);
    });
  }
  private publication(
    runId: string,
    completedSourceIds: string[],
    state?: 'completed',
    sourceOutputs?: WorkflowPublication['sourceOutputs'],
  ): WorkflowPublication {
    const row = this.db
      .prepare('SELECT next_sequence FROM workflow_runs WHERE run_id=?')
      .get(runId) as { next_sequence: number } | undefined;
    if (!row) throw new Error('Workflow run unavailable');
    const publication: WorkflowPublication = {
      sequence: row.next_sequence,
      checkpointRef: randomUUID(),
      completedSourceIds,
      ...(state ? { state } : {}),
      ...(sourceOutputs ? { sourceOutputs } : {}),
    };
    this.db
      .prepare('INSERT INTO workflow_publications(run_id,sequence,payload_json) VALUES(?,?,?)')
      .run(runId, publication.sequence, json(publication));
    this.db
      .prepare('UPDATE workflow_runs SET next_sequence=next_sequence+1 WHERE run_id=?')
      .run(runId);
    return publication;
  }
  completeSource(runId: string, sourceId: string): void {
    this.transaction(() => {
      if (this.sourceCompleted(runId, sourceId)) return;
      const plan = this.pendingPlan(runId, sourceId);
      if (plan?.state !== 'completed') throw new Error('Workflow source has not completed');
      this.db
        .prepare(
          'UPDATE workflow_sources SET complete=1,checkpoint_json=? WHERE run_id=? AND source_id=?',
        )
        .run(json(plan.checkpoint, WORKFLOW_LIMITS.checkpoint), runId, sourceId);
      this.publication(
        runId,
        [sourceId],
        undefined,
        plan.output === undefined
          ? undefined
          : [{ sourceId, outputJson: json(plan.output, WORKFLOW_LIMITS.checkpoint) }],
      );
    });
  }
  finishRun(runId: string): void {
    this.transaction(() => {
      if (this.runFinished(runId)) return;
      if (
        this.db
          .prepare('SELECT 1 FROM workflow_sources WHERE run_id=? AND complete=0 LIMIT 1')
          .get(runId)
      )
        throw new Error('Workflow sources are incomplete');
      this.publication(runId, [], 'completed');
      this.db.prepare('UPDATE workflow_runs SET finished=1 WHERE run_id=?').run(runId);
    });
  }
  initializeSource(
    runId: string,
    sourceId: string,
    workflowDigest: string,
    input: JsonValue,
  ): void {
    id(runId);
    id(sourceId);
    if (!/^[a-f0-9]{64}$/.test(workflowDigest)) throw new Error('Invalid workflow version pin');
    const value = json(input);
    const existing = this.db
      .prepare(
        'SELECT workflow_digest,input_json FROM workflow_sources WHERE run_id=? AND source_id=?',
      )
      .get(runId, sourceId) as { workflow_digest: string; input_json: string } | undefined;
    if (existing) {
      if (
        existing.workflow_digest !== workflowDigest ||
        digest(JSON.parse(existing.input_json)) !== digest(input)
      )
        throw new Error('Workflow source configuration changed');
      return;
    }
    this.db
      .prepare(
        'INSERT INTO workflow_sources(run_id,source_id,workflow_digest,input_json) VALUES(?,?,?,?)',
      )
      .run(runId, sourceId, workflowDigest, value);
  }
  getOperation(operationId: string): StoredWorkflowOperation | null {
    const row = this.operationRow(operationId);
    return row ? stored(row) : null;
  }
  private operationRow(operationId: string): OperationRow | undefined {
    return this.db
      .prepare('SELECT * FROM workflow_operations WHERE id=?')
      .get(operationId) as unknown as OperationRow | undefined;
  }
  beginOperation(input: WorkflowOperationInput): StoredWorkflowOperation {
    for (const value of [
      input.runId,
      input.sourceId,
      input.stepId,
      input.bindingId,
      input.request.operationId,
    ])
      id(value);
    const request = input.request;
    json(request);
    if (
      !Number.isSafeInteger(request.major) ||
      request.major < 1 ||
      !Number.isFinite(Date.parse(request.deadline)) ||
      !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(request.capability)
    )
      throw new Error('Invalid workflow operation');
    const source = this.db
      .prepare('SELECT workflow_digest FROM workflow_sources WHERE run_id=? AND source_id=?')
      .get(input.runId, input.sourceId) as { workflow_digest: string } | undefined;
    if (!source || source.workflow_digest !== input.workflowDigest)
      throw new Error('Workflow source version is unavailable');
    const hash = digest([
      input.runId,
      input.sourceId,
      input.stepId,
      input.bindingId,
      input.workflowDigest,
      request.capability,
      request.major,
      request.input,
    ]);
    return this.transaction(() => {
      const existing = this.operationRow(request.operationId);
      if (existing) {
        if (existing.input_digest !== hash)
          throw new Error('Workflow operation ID was reused for different input');
        return stored(existing);
      }
      this.db
        .prepare(
          "INSERT INTO workflow_operations(id,run_id,source_id,step_id,binding_id,workflow_digest,input_digest,request_json,state) VALUES(?,?,?,?,?,?,?,?,'prepared')",
        )
        .run(
          request.operationId,
          input.runId,
          input.sourceId,
          input.stepId,
          input.bindingId,
          input.workflowDigest,
          hash,
          json(request),
        );
      return this.getOperation(request.operationId) as StoredWorkflowOperation;
    });
  }
  markSubmitting(operationId: string): void {
    const result = this.db
      .prepare("UPDATE workflow_operations SET state='submitting' WHERE id=? AND state='prepared'")
      .run(operationId);
    if (!result.changes) throw new Error('Workflow operation cannot be submitted again');
  }
  saveAcceptedHandle(operationId: string, handle: JsonValue): void {
    const value = json(handle, WORKFLOW_LIMITS.checkpoint);
    const result = this.db
      .prepare(
        "UPDATE workflow_operations SET state='pending',handle_json=? WHERE id=? AND state IN ('submitting','pending')",
      )
      .run(value, operationId);
    if (!result.changes) throw new Error('Workflow operation is not waiting for a backend');
  }
  markUncertain(operationId: string): void {
    this.db
      .prepare("UPDATE workflow_operations SET state='uncertain' WHERE id=? AND state='submitting'")
      .run(operationId);
  }
  resumeSnapshot(runId: string, sourceId: string): WorkflowSnapshot | null {
    const source = this.db
      .prepare(
        'SELECT input_json,checkpoint_json FROM workflow_sources WHERE run_id=? AND source_id=?',
      )
      .get(runId, sourceId) as { input_json: string; checkpoint_json: string } | undefined;
    if (!source) return null;
    const results = this.db
      .prepare(
        "SELECT step_id,result_json FROM workflow_operations WHERE run_id=? AND source_id=? AND state IN ('completed','failed') ORDER BY step_id",
      )
      .all(runId, sourceId) as { step_id: string; result_json: string }[];
    return {
      input: JSON.parse(source.input_json),
      checkpoint: JSON.parse(source.checkpoint_json),
      completed: Object.fromEntries(
        results.map((result) => [
          result.step_id,
          validateOperationResult(JSON.parse(result.result_json)),
        ]),
      ),
    };
  }
  commitStep(
    operationId: string,
    result: OperationResult,
    checkpoint: JsonValue,
  ): WorkflowPublication {
    validateOperationResult(result);
    if (result.state === 'pending') throw new Error('Pending operations require a backend handle');
    const resultJson = json(result),
      checkpointJson = json(checkpoint, WORKFLOW_LIMITS.checkpoint);
    const committedDigest = digest([result, checkpoint]);
    return this.transaction(() => {
      const operation = this.operationRow(operationId);
      if (!operation) throw new Error('Workflow operation not found');
      if (operation.commit_digest !== null) {
        if (operation.commit_digest !== committedDigest || !operation.publication_json)
          throw new Error('Workflow result conflicts with its committed step');
        return JSON.parse(operation.publication_json) as WorkflowPublication;
      }
      if (!['submitting', 'pending'].includes(operation.state))
        throw new Error('Workflow step has not returned a confirmed result');
      const row = this.db
        .prepare('SELECT next_sequence FROM workflow_runs WHERE run_id=?')
        .get(operation.run_id) as { next_sequence: number };
      const publication: WorkflowPublication = {
        sequence: row.next_sequence,
        checkpointRef: randomUUID(),
        completedSourceIds: [],
      };
      const publicationJson = json(publication);
      this.db
        .prepare(
          'UPDATE workflow_operations SET state=?,handle_json=NULL,result_json=?,commit_digest=?,publication_json=? WHERE id=?',
        )
        .run(
          result.state === 'completed' ? 'completed' : 'failed',
          resultJson,
          committedDigest,
          publicationJson,
          operationId,
        );
      this.db
        .prepare('UPDATE workflow_sources SET checkpoint_json=? WHERE run_id=? AND source_id=?')
        .run(checkpointJson, operation.run_id, operation.source_id);
      this.db
        .prepare('INSERT INTO workflow_publications(run_id,sequence,payload_json) VALUES(?,?,?)')
        .run(operation.run_id, publication.sequence, publicationJson);
      this.db
        .prepare('UPDATE workflow_runs SET next_sequence=next_sequence+1 WHERE run_id=?')
        .run(operation.run_id);
      return publication;
    });
  }
  pendingPublications(runId: string): WorkflowPublication[] {
    return (
      this.db
        .prepare('SELECT payload_json FROM workflow_publications WHERE run_id=? ORDER BY sequence')
        .all(runId) as { payload_json: string }[]
    ).map((row) => JSON.parse(row.payload_json) as WorkflowPublication);
  }
  acknowledgePublication(runId: string, sequence: number): void {
    this.db
      .prepare('DELETE FROM workflow_publications WHERE run_id=? AND sequence=?')
      .run(runId, sequence);
  }
}

export async function openWorkflowState(directory: string): Promise<WorkflowStateStore> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  const directoryInfo = await lstat(root);
  if (
    process.platform !== 'win32' &&
    ((directoryInfo.mode & 0o077) !== 0 ||
      (process.getuid && directoryInfo.uid !== process.getuid()))
  )
    throw new Error('Workflow state requires an owner-only private directory');
  const filename = join(root, 'workflow-host.sqlite');
  try {
    const file = await open(filename, 'wx', 0o600);
    await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(filename);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  )
    throw new Error('Workflow state requires a private regular file');
  const db = new DatabaseSync(filename);
  try {
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (![0, 1, 2, 3].includes(version.user_version))
      throw new Error('Unsupported workflow state schema');
    if (version.user_version === 0) {
      const existing = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all();
      if (existing.length) throw new Error('Unrecognized workflow state database');
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE workflow_runs(run_id TEXT PRIMARY KEY,next_sequence INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE workflow_sources(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),source_id TEXT NOT NULL,workflow_digest TEXT NOT NULL,input_json TEXT NOT NULL,checkpoint_json TEXT NOT NULL DEFAULT 'null',PRIMARY KEY(run_id,source_id));
        CREATE TABLE workflow_operations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,source_id TEXT NOT NULL,step_id TEXT NOT NULL,binding_id TEXT NOT NULL,workflow_digest TEXT NOT NULL,input_digest TEXT NOT NULL,request_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','submitting','pending','completed','failed','uncertain')),handle_json TEXT,result_json TEXT,commit_digest TEXT,publication_json TEXT,UNIQUE(run_id,source_id,step_id),FOREIGN KEY(run_id,source_id) REFERENCES workflow_sources(run_id,source_id));
        CREATE TABLE workflow_publications(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),sequence INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,sequence));
        PRAGMA user_version=1; COMMIT;`);
    }
    if (version.user_version < 2) {
      db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE workflow_runs ADD COLUMN finished INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE workflow_sources ADD COLUMN plan_json TEXT;
        ALTER TABLE workflow_sources ADD COLUMN complete INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE workflow_sources ADD COLUMN advance_count INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version=2; COMMIT;`);
    }
    if (version.user_version < 3)
      db.exec(
        'BEGIN IMMEDIATE; ALTER TABLE workflow_runs ADD COLUMN lease_json TEXT; PRAGMA user_version=3; COMMIT;',
      );
    db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;',
    );
    return new WorkflowStateStore(db);
  } catch (error) {
    db.close();
    throw error;
  }
}
