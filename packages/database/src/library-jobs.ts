import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { DomainError } from '@ecs/domain';

export interface LibraryJobScope {
  rootId?: string;
  libraryId?: string;
  unassigned?: boolean;
}
export interface LibraryJobOptions {
  online: boolean;
  checksum: boolean;
  allowExactNames?: boolean;
  providerIds?: string[];
  managerId?: string;
}
export interface LibraryJobItem {
  sourceId: string;
  status: 'pending' | 'saved' | 'review' | 'unmatched' | 'failed' | 'skipped' | 'reviewed';
  saved: number;
  suggestions: number;
  error: string | null;
}
export interface LibraryJobRecord {
  id: string;
  kind: 'scan' | 'match';
  scope: LibraryJobScope;
  options: LibraryJobOptions;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  total: number;
  processed: number;
  saved: number;
  review: number;
  unmatched: number;
  failed: number;
  skipped: number;
  currentSourceId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  interruptedCount: number;
}
interface Row
  extends Pick<
    LibraryJobRecord,
    'total' | 'processed' | 'saved' | 'review' | 'unmatched' | 'failed' | 'skipped'
  > {
  id: string;
  kind: LibraryJobRecord['kind'];
  scope_json: string;
  options_json: string;
  state: LibraryJobRecord['state'];
  actor_id: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  interrupted_count: number;
  current_id: string | null;
}

/** Durable queue and keyset work list. No browser owns a job or its cancellation. */
export class LibraryJobRepository {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): LibraryJobRecord | null {
    const row = this.db.prepare('SELECT * FROM library_jobs WHERE id=?').get(id) as Row | undefined;
    if (!row) return null;
    const { total, processed, saved, review, unmatched, failed, skipped } = row;
    const counts = { total, processed, saved, review, unmatched, failed, skipped };
    return {
      id: row.id,
      kind: row.kind,
      scope: JSON.parse(row.scope_json),
      options: JSON.parse(row.options_json),
      state: row.state,
      ...counts,
      currentSourceId: row.current_id,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      interruptedCount: row.interrupted_count,
    };
  }
  list(limit = 25, before?: string): LibraryJobRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id FROM library_jobs WHERE (? IS NULL OR (created_at,id) < (SELECT created_at,id FROM library_jobs WHERE id=?)) ORDER BY created_at DESC,id DESC LIMIT ?',
      )
      .all(before ?? null, before ?? null, Math.min(101, Math.max(1, limit))) as { id: string }[];
    return rows.map((row) => this.get(row.id) as LibraryJobRecord);
  }
  create(
    kind: LibraryJobRecord['kind'],
    scope: LibraryJobScope,
    options: LibraryJobOptions,
    actorId: string,
  ): { job: LibraryJobRecord; reused: boolean } {
    const optionsJson = JSON.stringify(normalizedOptions(kind, options));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db
        .prepare(
          "SELECT * FROM library_jobs WHERE state IN ('queued','running','interrupted') AND kind=?",
        )
        .all(kind) as unknown as Row[];
      for (const row of active) {
        const existing = JSON.parse(row.scope_json) as LibraryJobScope;
        const sameOptions =
          JSON.stringify(
            normalizedOptions(kind, JSON.parse(row.options_json) as LibraryJobOptions),
          ) === optionsJson;
        if (row.scope_json === JSON.stringify(scope) && sameOptions) {
          this.db.exec('COMMIT');
          return { job: this.get(row.id) as LibraryJobRecord, reused: true };
        }
        const a = this.rootIds(existing);
        const b = this.rootIds(scope);
        if (!b.some((id) => a.includes(id))) continue;
        if (sameOptions && b.every((id) => a.includes(id))) {
          this.db.exec('COMMIT');
          return { job: this.get(row.id) as LibraryJobRecord, reused: true };
        }
        throw new DomainError(
          'library-job-conflict',
          409,
          'A shared job already covers part of this scope. Finish or cancel it before starting another.',
        );
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO library_jobs(id,kind,scope_json,options_json,state,actor_id,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?)",
        )
        .run(id, kind, JSON.stringify(scope), optionsJson, actorId, now, now);
      const filter = scopeSql(scope);
      if (kind === 'scan')
        this.db
          .prepare(
            `INSERT INTO library_job_items(job_id,entity_id) SELECT ?,r.id FROM content_roots r WHERE ${filter.sql}`,
          )
          .run(id, ...filter.params);
      else
        this.db
          .prepare(
            `INSERT INTO library_job_items(job_id,entity_id) SELECT ?,s.id FROM live_source_files s JOIN content_roots r ON r.id=s.root_id WHERE s.kind='rom' AND (s.group_anchor IS NULL OR s.group_anchor=s.relative_path) AND ${filter.sql}`,
          )
          .run(id, ...filter.params);
      this.db
        .prepare(
          'UPDATE library_jobs SET total=(SELECT count(*) FROM library_job_items WHERE job_id=?) WHERE id=?',
        )
        .run(id, id);
      this.db.exec('COMMIT');
      return { job: this.get(id) as LibraryJobRecord, reused: false };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private rootIds(scope: LibraryJobScope): string[] {
    const filter = scopeSql(scope);
    return (
      this.db
        .prepare(`SELECT r.id FROM content_roots r WHERE ${filter.sql}`)
        .all(...filter.params) as { id: string }[]
    ).map((row) => row.id);
  }
  recover(): void {
    this.db
      .prepare(
        "UPDATE library_jobs SET state='interrupted', current_id=NULL, interrupted_count=interrupted_count+1,error='Server stopped during this job. Resume to continue pending work.',updated_at=? WHERE state='running'",
      )
      .run(new Date().toISOString());
  }
  next(): { job: LibraryJobRecord; actorId: string } | null {
    const row = this.db
      .prepare("SELECT * FROM library_jobs WHERE state='queued' ORDER BY created_at,id LIMIT 1")
      .get() as Row | undefined;
    if (!row) return null;
    if (row.kind === 'match') {
      // A scan queued ahead of this job can discover new sources. Refresh the
      // durable snapshot once at claim; completed outcomes still deduplicate on resume.
      const filter = scopeSql(JSON.parse(row.scope_json) as LibraryJobScope);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO library_job_items(job_id,entity_id) SELECT ?,s.id FROM live_source_files s JOIN content_roots r ON r.id=s.root_id WHERE s.kind='rom' AND (s.group_anchor IS NULL OR s.group_anchor=s.relative_path) AND ${filter.sql}`,
        )
        .run(row.id, ...filter.params);
      this.db
        .prepare(
          'UPDATE library_jobs SET total=(SELECT count(*) FROM library_job_items WHERE job_id=?) WHERE id=?',
        )
        .run(row.id, row.id);
    }
    this.state(row.id, 'running');
    return { job: this.get(row.id) as LibraryJobRecord, actorId: row.actor_id };
  }
  items(id: string, limit = 100, after?: string, status?: string): LibraryJobItem[] {
    const query = libraryJobItemsQuery(id, limit, after, status);
    const rows = this.db.prepare(query.sql).all(...query.params) as unknown as LibraryJobItem[];
    return rows;
  }
  current(id: string, entityId: string): void {
    this.db
      .prepare('UPDATE library_jobs SET current_id=?,updated_at=? WHERE id=?')
      .run(entityId, new Date().toISOString(), id);
  }
  finishItem(id: string, item: LibraryJobItem): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare(
          "UPDATE library_job_items SET state=?,saved=?,suggestions=?,error=? WHERE job_id=? AND entity_id=? AND state='pending'",
        )
        .run(item.status, item.saved, item.suggestions, item.error, id, item.sourceId);
      if (result.changes)
        this.db
          .prepare(
            'UPDATE library_jobs SET current_id=NULL,updated_at=?,processed=processed+1,saved=saved+?,review=review+?,unmatched=unmatched+?,failed=failed+?,skipped=skipped+? WHERE id=?',
          )
          .run(
            new Date().toISOString(),
            item.saved,
            Number(item.status === 'review'),
            Number(item.status === 'unmatched'),
            Number(item.status === 'failed'),
            Number(item.status === 'skipped'),
            id,
          );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  state(
    id: string,
    state: LibraryJobRecord['state'],
    error: string | null = null,
  ): LibraryJobRecord {
    if (!this.get(id)) throw new DomainError('not-found', 404, 'Shared job not found');
    this.db
      .prepare('UPDATE library_jobs SET state=?,error=?,current_id=NULL,updated_at=? WHERE id=?')
      .run(state, error, new Date().toISOString(), id);
    return this.get(id) as LibraryJobRecord;
  }
  reviewed(id: string, sourceId: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT state FROM library_job_items WHERE job_id=? AND entity_id=?')
        .get(id, sourceId) as { state: LibraryJobItem['status'] } | undefined;
      if (!row) throw new DomainError('not-found', 404, 'Job result not found');
      if (row.state === 'pending')
        throw new DomainError(
          'library-job-conflict',
          409,
          'Wait for matching to finish before reviewing this result',
        );
      if (row.state !== 'reviewed') {
        this.db
          .prepare("UPDATE library_job_items SET state='reviewed' WHERE job_id=? AND entity_id=?")
          .run(id, sourceId);
        this.db
          .prepare(
            'UPDATE library_jobs SET review=review-?,unmatched=unmatched-?,failed=failed-?,skipped=skipped-?,updated_at=? WHERE id=?',
          )
          .run(
            Number(row.state === 'review'),
            Number(row.state === 'unmatched'),
            Number(row.state === 'failed'),
            Number(row.state === 'skipped'),
            new Date().toISOString(),
            id,
          );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  scanResult(
    id: string,
    rootId: string,
  ): { rootId: string; medium: string; online: boolean; count: number } | null {
    const row = this.db
      .prepare('SELECT result_json FROM library_job_items WHERE job_id=? AND entity_id=?')
      .get(id, rootId) as { result_json: string | null } | undefined;
    return row?.result_json ? JSON.parse(row.result_json) : null;
  }
  saveScanResult(
    id: string,
    rootId: string,
    result: { rootId: string; medium: string; online: boolean; count: number },
  ): void {
    this.db
      .prepare('UPDATE library_job_items SET result_json=? WHERE job_id=? AND entity_id=?')
      .run(JSON.stringify(result), id, rootId);
  }
  resume(id: string, retry?: 'failed' | 'unmatched'): LibraryJobRecord {
    const job = this.get(id);
    if (!job) throw new DomainError('not-found', 404, 'Shared job not found');
    if (job.state === 'running' || job.state === 'queued') return job;
    if (job.state === 'completed' && !retry) return job;
    for (const active of this.db
      .prepare(
        "SELECT id,scope_json FROM library_jobs WHERE kind=? AND state IN ('queued','running','interrupted') AND id!=?",
      )
      .all(job.kind, id) as { id: string; scope_json: string }[]) {
      const roots = this.rootIds(JSON.parse(active.scope_json) as LibraryJobScope);
      if (this.rootIds(job.scope).some((root) => roots.includes(root)))
        throw new DomainError(
          'library-job-conflict',
          409,
          'Another shared job covers this scope. Finish or cancel it before resuming.',
        );
    }
    if (retry) {
      this.db
        .prepare(
          "UPDATE library_job_items SET state='pending',saved=0,suggestions=0,error=NULL WHERE job_id=? AND state=?",
        )
        .run(id, retry);
      this.db
        .prepare(`UPDATE library_jobs SET processed=(SELECT count(*) FROM library_job_items WHERE job_id=? AND state!='pending'),
        saved=(SELECT COALESCE(sum(saved),0) FROM library_job_items WHERE job_id=?),review=(SELECT count(*) FROM library_job_items WHERE job_id=? AND state='review'),
        unmatched=(SELECT count(*) FROM library_job_items WHERE job_id=? AND state='unmatched'),failed=(SELECT count(*) FROM library_job_items WHERE job_id=? AND state='failed'),skipped=(SELECT count(*) FROM library_job_items WHERE job_id=? AND state='skipped') WHERE id=?`)
        .run(id, id, id, id, id, id, id);
    }
    return this.state(id, 'queued');
  }
}
function scopeSql(scope: LibraryJobScope): { sql: string; params: SQLInputValue[] } {
  if (scope.rootId) return { sql: 'r.id=?', params: [scope.rootId] };
  if (scope.libraryId)
    return {
      sql: 'r.library_id=? AND EXISTS(SELECT 1 FROM libraries l WHERE l.id=r.library_id AND l.deleted_at IS NULL)',
      params: [scope.libraryId],
    };
  if (scope.unassigned) return { sql: 'r.library_id IS NULL', params: [] };
  return {
    sql: '(r.library_id IS NULL OR EXISTS(SELECT 1 FROM libraries l WHERE l.id=r.library_id AND l.deleted_at IS NULL))',
    params: [],
  };
}

/** Exact optional predicates let SQLite seek the state index after any processed prefix. */
export function libraryJobItemsQuery(
  id: string,
  limit = 100,
  after?: string,
  status?: string,
): { sql: string; params: SQLInputValue[] } {
  const clauses = ['job_id=?'];
  const params: SQLInputValue[] = [id];
  if (status !== undefined) {
    clauses.push('state=?');
    params.push(status);
  }
  if (after !== undefined) {
    clauses.push('entity_id>?');
    params.push(after);
  }
  params.push(Math.min(101, Math.max(1, limit)));
  return {
    sql: `SELECT entity_id AS sourceId,state AS status,saved,suggestions,error FROM library_job_items WHERE ${clauses.join(' AND ')} ORDER BY entity_id LIMIT ?`,
    params,
  };
}

function normalizedOptions(kind: LibraryJobRecord['kind'], options: LibraryJobOptions) {
  return kind === 'scan'
    ? { online: false, checksum: false }
    : {
        online: options.online,
        checksum: options.checksum,
        ...(options.allowExactNames ? { allowExactNames: true } : {}),
        ...(options.managerId ? { managerId: options.managerId } : {}),
        ...(options.providerIds ? { providerIds: [...options.providerIds].sort() } : {}),
      };
}
