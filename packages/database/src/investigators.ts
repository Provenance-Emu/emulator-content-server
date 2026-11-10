import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  requireWorkflowOwner,
  workflowError,
  workflowJson,
  workflowTransaction,
} from './workflow-data.js';

export const investigatorOperations = ['inspect', 'cleanup', 'suggest', 'diagnostics'] as const;
export type InvestigatorOperation = (typeof investigatorOperations)[number];
interface Grant {
  libraryIds: string[];
  operations: InvestigatorOperation[];
}
export interface InvestigatorCredential extends Grant {
  id: string;
  expiresAt: string;
}
export interface InvestigatorPrincipal extends InvestigatorCredential {
  ownerId: string;
}
interface Row {
  id: string;
  owner_id: string;
  expires_at: string;
  grant_json: string;
}
function principal(row: Row): InvestigatorPrincipal {
  return {
    id: row.id,
    ownerId: row.owner_id,
    expiresAt: row.expires_at,
    ...(JSON.parse(row.grant_json) as Grant),
  };
}
export function investigatorHostId(id: string): string {
  return `investigator:${id}`;
}

export class InvestigatorRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(
    ownerId: string,
    tokenHash: string,
    grant: Grant,
    ttlSeconds: number,
  ): InvestigatorCredential {
    requireWorkflowOwner(this.db, ownerId);
    const now = Date.now();
    const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
    const id = randomUUID();
    return workflowTransaction(this.db, () => {
      if (this.list(ownerId, now).length >= 32) workflowError('quota-exceeded', 429);
      this.db
        .prepare(
          'INSERT INTO workflow_access_tokens(id,owner_id,token_hash,grant_json,expires_at) VALUES(?,?,?,?,?)',
        )
        .run(id, ownerId, tokenHash, workflowJson(grant), expiresAt);
      // The existing review records require a host foreign key. This internal
      // record has neither an enrollment secret nor a worker token.
      this.db
        .prepare('INSERT INTO workflow_hosts(id,owner_id,name,created_at) VALUES(?,?,?,?)')
        .run(investigatorHostId(id), ownerId, 'MCP investigator', new Date(now).toISOString());
      return { id, expiresAt, ...grant };
    });
  }

  list(ownerId: string, now = Date.now()): InvestigatorCredential[] {
    requireWorkflowOwner(this.db, ownerId);
    return (
      this.db
        .prepare(
          'SELECT id,owner_id,grant_json,expires_at FROM workflow_access_tokens WHERE owner_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY expires_at,id LIMIT 32',
        )
        .all(ownerId, new Date(now).toISOString()) as unknown as Row[]
    ).map(({ owner_id: _owner, id, expires_at, grant_json }) => ({
      id,
      expiresAt: expires_at,
      ...(JSON.parse(grant_json) as Grant),
    }));
  }

  authenticate(tokenHash: string): InvestigatorPrincipal | null {
    const row = this.db
      .prepare(
        'SELECT t.id,t.owner_id,t.grant_json,t.expires_at FROM workflow_access_tokens t JOIN users u ON u.id=t.owner_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>? AND u.is_owner=1',
      )
      .get(tokenHash, new Date(Date.now()).toISOString()) as Row | undefined;
    return row ? principal(row) : null;
  }

  isActive(id: string, now = Date.now()): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM workflow_access_tokens t JOIN users u ON u.id=t.owner_id WHERE t.id=? AND t.revoked_at IS NULL AND t.expires_at>? AND u.is_owner=1',
      )
      .get(id, new Date(now).toISOString());
  }

  revoke(ownerId: string, id: string): void {
    requireWorkflowOwner(this.db, ownerId);
    const now = Date.now();
    workflowTransaction(this.db, () => {
      this.db
        .prepare(
          'UPDATE workflow_access_tokens SET revoked_at=? WHERE id=? AND owner_id=? AND revoked_at IS NULL',
        )
        .run(new Date(now).toISOString(), id, ownerId);
      this.expireRuns(now);
    });
  }

  expireRuns(now = Date.now()): void {
    const at = new Date(now).toISOString();
    this.db
      .prepare(`UPDATE workflow_runs SET state='cancelled',revision=revision+1,updated_at=?
      WHERE state='running' AND host_id GLOB 'investigator:*' AND NOT EXISTS (
        SELECT 1 FROM workflow_access_tokens t JOIN users u ON u.id=t.owner_id
        WHERE t.id=substr(workflow_runs.host_id,length('investigator:')+1) AND t.revoked_at IS NULL AND t.expires_at>? AND u.is_owner=1
      )`)
      .run(at, at);
  }

  markInspected(runId: string, hostId: string, sourceId: string): void {
    workflowTransaction(this.db, () => {
      const updated = this.db
        .prepare(
          "UPDATE workflow_work SET state='completed' WHERE run_id=? AND source_id=? AND state='pending' AND EXISTS(SELECT 1 FROM workflow_runs WHERE id=? AND host_id=? AND state='running')",
        )
        .run(runId, sourceId, runId, hostId);
      if (updated.changes)
        this.db
          .prepare(
            'UPDATE workflow_runs SET processed=processed+1,revision=revision+1,updated_at=? WHERE id=?',
          )
          .run(new Date().toISOString(), runId);
    });
  }

  finish(runId: string, hostId: string): void {
    const updated = this.db
      .prepare(
        "UPDATE workflow_runs SET state='completed',revision=revision+1,updated_at=? WHERE id=? AND host_id=? AND state='running' AND total=processed",
      )
      .run(new Date().toISOString(), runId, hostId);
    if (!updated.changes) workflowError('workflow-state-conflict');
  }

  sources(libraryId: string, cursor: string | undefined, limit: number) {
    const rows = this.db
      .prepare(`SELECT s.id,s.display_name AS name,s.system_id AS systemId
      FROM live_source_files s JOIN content_roots r ON r.id=s.root_id
      WHERE r.library_id=? AND s.kind='rom' AND (s.group_anchor IS NULL OR s.group_anchor=s.relative_path)
      AND s.id>? ORDER BY s.id LIMIT ?`)
      .all(libraryId, cursor ?? '', limit + 1) as {
      id: string;
      name: string;
      systemId: string | null;
    }[];
    return {
      items: rows.slice(0, limit),
      nextCursor: rows[limit]?.id ? (rows[limit - 1]?.id ?? null) : null,
    };
  }

  diagnostics(libraryIds: string[]) {
    const host = this.db
      .prepare(
        'SELECT 1 FROM workflow_hosts WHERE token_hash IS NOT NULL AND revoked_at IS NULL AND last_seen_at>? LIMIT 1',
      )
      .get(new Date(Date.now() - 120_000).toISOString());
    const jobs = this.db
      .prepare(`SELECT kind,state,count(*) AS count FROM library_jobs
      WHERE state IN ('queued','running','interrupted')
      AND json_extract(scope_json,'$.libraryId') IN (SELECT value FROM json_each(?))
      GROUP BY kind,state ORDER BY kind,state`)
      .all(workflowJson(libraryIds)) as { kind: string; state: string; count: number }[];
    return { workflowHostRecentlySeen: !!host, jobs };
  }
}
