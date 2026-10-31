import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '@ecs/domain';

export function workflowError(code: string, status = 409): never {
  throw new DomainError(
    code,
    status,
    'Workflow operation is unavailable or conflicts with current state',
  );
}
export function workflowTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function workflowDigest(value: unknown): string {
  function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, sorted(item)]),
      );
    return value;
  }
  return createHash('sha256')
    .update(JSON.stringify(sorted(value)))
    .digest('hex');
}
export function requireWorkflowOwner(db: DatabaseSync, ownerId: string): void {
  if (!db.prepare('SELECT id FROM users WHERE id=? AND is_owner=1').get(ownerId))
    workflowError('forbidden', 403);
}
export function requireWorkflowHost(db: DatabaseSync, hostId: string): void {
  if (
    !db
      .prepare(
        'SELECT h.id FROM workflow_hosts h JOIN users u ON u.id=h.owner_id WHERE h.id=? AND h.revoked_at IS NULL AND h.token_hash IS NOT NULL AND u.is_owner=1',
      )
      .get(hostId)
  )
    workflowError('forbidden', 403);
}
export function workflowPageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    workflowError('invalid-request', 400);
  return limit;
}
export function workflowJson(value: unknown, max = 1024 * 1024): string {
  const result = JSON.stringify(value);
  if (result === undefined || Buffer.byteLength(result) > max)
    workflowError('invalid-request', 400);
  return result;
}
