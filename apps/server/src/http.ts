import { createHash } from 'node:crypto';
import { authorize } from '@ecs/auth';
import type { CatalogDatabase } from '@ecs/database';
import { type Actor, type AssetRecord, DomainError, type ItemRecord } from '@ecs/domain';
import { type ItemPermission, problem } from '@ecs/protocol';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function sendProblem(
  reply: FastifyReply,
  error: DomainError,
  request: FastifyRequest,
): FastifyReply {
  return reply
    .status(error.status)
    .type('application/problem+json')
    .send(
      problem({
        code: error.code,
        title: error.message,
        status: error.status,
        detail: error.message,
        instance: request.url,
        requestId: request.id,
        errors: error.details,
      }),
    );
}

export function requireActor(request: FastifyRequest): Actor {
  if (!request.actor) throw new DomainError('unauthorized', 401, 'Authentication is required');
  return request.actor;
}

export function actorKey(actor: Actor): string {
  return actor.kind === 'user' ? `user:${actor.userId}` : `guest:${actor.grantId}`;
}

export function jsonObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DomainError('invalid-body', 400, 'Expected a JSON object');
  }
  return body as Record<string, unknown>;
}

export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError('invalid-body', 400, `Expected ${key}`);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new DomainError('invalid-body', 400, `Expected ${key}`);
  return value;
}

export function requiredInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new DomainError('invalid-body', 400, `Expected integer ${key}`);
  }
  return value;
}

export function optionalHex(value: unknown, length: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value)) {
    throw new DomainError('invalid-body', 400, 'Hash has the wrong shape');
  }
  return value.toLowerCase();
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new DomainError('invalid-body', 400, 'Expected an array of strings');
  }
  return value;
}

export async function withIdempotency(
  catalog: CatalogDatabase,
  actor: Actor,
  request: FastifyRequest,
  body: unknown,
  exec: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown }> {
  const header = request.headers['idempotency-key'];
  if (header === undefined) return exec();
  if (typeof header !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(header)) {
    throw new DomainError('invalid-body', 400, 'Idempotency-Key is invalid');
  }
  const requestHash = createHash('sha256')
    .update(JSON.stringify([request.method, request.url, body]))
    .digest('hex');
  const key = actorKey(actor);
  const existing = catalog.getIdempotency(key, header);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new DomainError(
        'idempotency-conflict',
        409,
        'Idempotency key was reused with a different request',
      );
    }
    return { status: existing.statusCode, body: JSON.parse(existing.responseJson) as unknown };
  }
  const result = await exec();
  catalog.saveIdempotency({
    actorKey: key,
    key: header,
    requestHash,
    statusCode: result.status,
    responseJson: JSON.stringify(result.body),
  });
  return result;
}

export function libraryDecision(
  catalog: CatalogDatabase,
  actor: Actor,
  libraryId: string,
  action: ItemPermission,
): void {
  const membership = actor.kind === 'user' ? catalog.membership(actor.userId, libraryId) : null;
  const allowed = authorize({
    actor,
    action,
    libraryId,
    itemId: actor.kind === 'guest' ? (actor.itemId ?? undefined) : undefined,
    membership,
  });
  if (!allowed) {
    throw new DomainError(
      membership ? 'forbidden' : 'not-found',
      membership ? 403 : 404,
      'Library is not available',
    );
  }
}

export function itemDecision(
  catalog: CatalogDatabase,
  actor: Actor,
  item: ItemRecord,
  action: ItemPermission,
): void {
  const membership =
    actor.kind === 'user' ? catalog.membership(actor.userId, item.libraryId) : null;
  const itemPermissions =
    actor.kind === 'user' ? catalog.itemPermissions(actor.userId, item.id) : [];
  const allowed = authorize({
    actor,
    action,
    libraryId: item.libraryId,
    itemId: item.id,
    membership,
    itemPermissions,
  });
  if (allowed) return;
  const visible = authorize({
    actor,
    action: 'read',
    libraryId: item.libraryId,
    itemId: item.id,
    membership,
    itemPermissions,
  });
  throw new DomainError(
    visible ? 'forbidden' : 'not-found',
    visible ? 403 : 404,
    'Item is not available',
  );
}

export function assetDecision(
  catalog: CatalogDatabase,
  actor: Actor,
  item: ItemRecord,
  asset: AssetRecord,
  action: ItemPermission,
): void {
  const membership =
    actor.kind === 'user' ? catalog.membership(actor.userId, item.libraryId) : null;
  const itemPermissions =
    actor.kind === 'user' ? catalog.itemPermissions(actor.userId, item.id) : [];
  const allowed = authorize({
    actor,
    action,
    libraryId: item.libraryId,
    itemId: item.id,
    assetKind: asset.kind,
    shareable: asset.shareable,
    membership,
    itemPermissions,
  });
  if (allowed) return;
  const visible = authorize({
    actor,
    action: 'read',
    libraryId: item.libraryId,
    itemId: item.id,
    membership,
    itemPermissions,
    shareable: true,
  });
  throw new DomainError(
    visible ? 'forbidden' : 'not-found',
    visible ? 403 : 404,
    'File is not available',
  );
}
