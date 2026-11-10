import { randomInt, randomUUID } from 'node:crypto';
import { hashToken, issueToken } from '@ecs/auth';
import { DomainError } from '@ecs/domain';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './context.js';
import { jsonObject, requiredString, requireOwner } from './http.js';

const lifetimeMs = 5 * 60_000;
const tokenLifetimeMs = 90 * 24 * 60 * 60_000;

interface Pairing {
  id: string;
  pin: string;
  name: string;
  secretHash: string;
  expiresAt: number;
  approvedBy?: string;
}

/** Short-lived approval state is deliberately lost when the server restarts.
 * Only the high-entropy secret held by the requesting device can claim a token.
 */
export function registerDevicePairing(app: FastifyInstance, context: ServerContext): void {
  const pending = new Map<string, Pairing>();
  const unavailable = () => new DomainError('not-found', 404, 'Pairing expired or not found');

  function prune() {
    const now = Date.now();
    for (const [id, request] of pending) {
      if (request.expiresAt <= now) pending.delete(id);
    }
  }

  function findPin(pin: string): Pairing {
    prune();
    const request = [...pending.values()].find((entry) => entry.pin === pin);
    if (!request || request.approvedBy) throw unavailable();
    return request;
  }

  app.post('/api/v1/device-pairing', async (request, reply) => {
    if (!context.catalog.server().bootstrapped || !context.uiDir) throw unavailable();
    if (!context.limiter.allow(`pair-start:${request.ip}`)) {
      throw new DomainError('rate-limited', 429, 'Too many pairing requests');
    }
    const name = requiredString(jsonObject(request.body), 'name').trim();
    if (!name || name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) {
      throw new DomainError('invalid-body', 400, 'Invalid device name');
    }
    prune();
    if (pending.size >= 128) {
      throw new DomainError('rate-limited', 429, 'Too many devices waiting to pair');
    }
    let pin: string;
    do {
      pin = String(randomInt(1_000_000)).padStart(6, '0');
    } while ([...pending.values()].some((entry) => entry.pin === pin));
    const secret = issueToken();
    const id = randomUUID();
    pending.set(id, { id, pin, name, secretHash: secret.hash, expiresAt: Date.now() + lifetimeMs });
    return reply
      .header('cache-control', 'no-store')
      .status(201)
      .send({ id, pin, secret: secret.token, expiresInSeconds: lifetimeMs / 1000 });
  });

  app.post('/api/v1/device-pairing/inspect', async (request, reply) => {
    const owner = requireOwner(request, 'Sign in as the owner to pair a device');
    if (!context.limiter.allow(`pair-inspect:${owner.userId}`)) {
      throw new DomainError('rate-limited', 429, 'Too many pairing attempts');
    }
    const entry = findPin(requiredString(jsonObject(request.body), 'pin'));
    return reply.header('cache-control', 'no-store').send({ id: entry.id, name: entry.name });
  });

  app.post('/api/v1/device-pairing/approve', async (request, reply) => {
    const owner = requireOwner(request, 'Sign in as the owner to pair a device');
    const body = jsonObject(request.body);
    const entry = findPin(requiredString(body, 'pin'));
    if (entry.id !== requiredString(body, 'id')) throw unavailable();
    entry.approvedBy = owner.userId;
    return reply.header('cache-control', 'no-store').send({ approved: true });
  });

  app.post('/api/v1/device-pairing/redeem', async (request, reply) => {
    prune();
    const body = jsonObject(request.body);
    const id = requiredString(body, 'id');
    const secret = requiredString(body, 'secret');
    const entry = pending.get(id);
    if (!entry || secret.length > 128 || hashToken(secret) !== entry.secretHash)
      throw unavailable();
    reply.header('cache-control', 'no-store');
    if (!entry.approvedBy) return reply.status(202).send();
    const issued = issueToken();
    const created = context.catalog.createDeviceToken({
      userId: entry.approvedBy,
      name: entry.name,
      tokenHash: issued.hash,
      scopes: ['read'],
      expiresAt: new Date(Date.now() + tokenLifetimeMs).toISOString(),
    });
    pending.delete(id);
    return reply.send({ id: created.id, token: issued.token, scopes: ['read'] });
  });
}
