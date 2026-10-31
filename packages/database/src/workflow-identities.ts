import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkflowHost, WorkflowPackageSummary } from '@ecs/domain';
import { requireWorkflowOwner, workflowError, workflowTransaction } from './workflow-data.js';

interface HostRow {
  id: string;
  owner_id: string;
  name: string;
  token_hash: string | null;
  created_at: string;
  revoked_at: string | null;
  packages_json: string;
  last_seen_at: string | null;
}
function summary(row: HostRow): WorkflowHost {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    enrolled: row.token_hash !== null,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    packages: JSON.parse(row.packages_json),
    lastSeenAt: row.last_seen_at,
  };
}
function hash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) workflowError('invalid-request', 400);
}

export class WorkflowIdentityRepository {
  constructor(private readonly db: DatabaseSync) {}
  createHost(
    ownerId: string,
    name: string,
    enrollmentHash: string,
    enrollmentExpires: number,
  ): WorkflowHost {
    requireWorkflowOwner(this.db, ownerId);
    hash(enrollmentHash);
    if (!name.trim() || name.length > 80 || !Number.isSafeInteger(enrollmentExpires))
      workflowError('invalid-request', 400);
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO workflow_hosts(id,owner_id,name,enrollment_hash,enrollment_expires,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(id, ownerId, name, enrollmentHash, enrollmentExpires, new Date().toISOString());
    return this.getHost(id) as WorkflowHost;
  }
  getHost(id: string): WorkflowHost | null {
    const row = this.db.prepare('SELECT * FROM workflow_hosts WHERE id=?').get(id) as unknown as
      | HostRow
      | undefined;
    return row ? summary(row) : null;
  }
  listHosts(): WorkflowHost[] {
    return (
      this.db
        .prepare('SELECT * FROM workflow_hosts ORDER BY created_at,id')
        .all() as unknown as HostRow[]
    ).map(summary);
  }
  enrollHost(enrollmentHash: string, tokenHash: string, now = Date.now()): WorkflowHost {
    hash(enrollmentHash);
    hash(tokenHash);
    return workflowTransaction(this.db, () => {
      const row = this.db
        .prepare(
          'SELECT id,owner_id FROM workflow_hosts WHERE enrollment_hash=? AND enrollment_expires>? AND token_hash IS NULL AND revoked_at IS NULL',
        )
        .get(enrollmentHash, now) as { id: string; owner_id: string } | undefined;
      if (!row) workflowError('unauthorized', 401);
      requireWorkflowOwner(this.db, row.owner_id);
      this.db
        .prepare(
          'UPDATE workflow_hosts SET enrollment_hash=NULL,enrollment_expires=NULL,token_hash=? WHERE id=?',
        )
        .run(tokenHash, row.id);
      return this.getHost(row.id) as WorkflowHost;
    });
  }
  authenticateHost(tokenHash: string): WorkflowHost | null {
    hash(tokenHash);
    const row = this.db
      .prepare(
        'SELECT h.* FROM workflow_hosts h JOIN users u ON u.id=h.owner_id WHERE h.token_hash=? AND h.revoked_at IS NULL AND u.is_owner=1',
      )
      .get(tokenHash) as unknown as HostRow | undefined;
    return row ? summary(row) : null;
  }
  advertiseHost(id: string, packages: WorkflowPackageSummary[]): void {
    if (
      !Array.isArray(packages) ||
      packages.length > 128 ||
      new Set(packages.map((p) => p?.id)).size !== packages.length
    )
      workflowError('invalid-request', 400);
    for (const p of packages) {
      if (
        !p ||
        Object.keys(p).sort().join(',') !== 'digest,id,kind,name,version' ||
        !/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(p.id) ||
        p.id.length > 200 ||
        typeof p.name !== 'string' ||
        !p.name.trim() ||
        p.name.length > 80 ||
        typeof p.version !== 'string' ||
        p.version.length > 80 ||
        !/^[a-f0-9]{64}$/.test(p.digest) ||
        !['workflow', 'translator', 'tool'].includes(p.kind)
      )
        workflowError('invalid-request', 400);
    }
    this.db
      .prepare(
        'UPDATE workflow_hosts SET packages_json=?,last_seen_at=? WHERE id=? AND revoked_at IS NULL',
      )
      .run(JSON.stringify(packages), new Date().toISOString(), id);
  }
  revokeHost(id: string, actorId: string): void {
    requireWorkflowOwner(this.db, actorId);
    this.db
      .prepare(
        'UPDATE workflow_hosts SET revoked_at=?,enrollment_hash=NULL,token_hash=NULL WHERE id=?',
      )
      .run(new Date().toISOString(), id);
  }
}
