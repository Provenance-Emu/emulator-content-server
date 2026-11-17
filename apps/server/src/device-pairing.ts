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
  pin?: string;
  name: string;
  secretHash: string;
  expiresAt: number;
  requestFirst: boolean;
  attemptsRemaining: number;
  approvedBy?: string;
}

interface Invitation {
  ownerId: string;
  pin: string;
  expiresAt: number;
  attemptsRemaining: number;
}

/** Short-lived approval state is deliberately lost when the server restarts.
 * Only the high-entropy secret held by the requesting device can claim a token.
 */
export function registerDevicePairing(app: FastifyInstance, context: ServerContext): void {
  const pending = new Map<string, Pairing>();
  const invitations = new Map<string, Invitation>();
  const unavailable = () => new DomainError('not-found', 404, 'Pairing expired or not found');

  function prune() {
    const now = Date.now();
    for (const [id, request] of pending) {
      if (request.expiresAt <= now) pending.delete(id);
    }
    for (const [id, invite] of invitations) {
      if (invite.expiresAt <= now) invitations.delete(id);
    }
  }

  function findPin(pin: string): Pairing {
    prune();
    const request = [...pending.values()].find((entry) => !entry.requestFirst && entry.pin === pin);
    if (!request || request.approvedBy) throw unavailable();
    return request;
  }

  function newPin(): string {
    let pin: string;
    do {
      pin = String(randomInt(1_000_000)).padStart(6, '0');
    } while ([...pending.values()].some((entry) => entry.pin === pin));
    return pin;
  }

  function deviceName(body: unknown) {
    const name = requiredString(jsonObject(body), 'name').trim();
    if (!name || name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) {
      throw new DomainError('invalid-body', 400, 'Invalid device name');
    }
    return name;
  }

  function start(ip: string, body: unknown, requestFirst: boolean) {
    if (!context.catalog.server().bootstrapped || !context.uiDir) throw unavailable();
    if (!context.limiter.allow(`pair-start:${ip}`)) {
      throw new DomainError('rate-limited', 429, 'Too many pairing requests');
    }
    const name = deviceName(body);
    prune();
    if (pending.size >= 128) {
      throw new DomainError('rate-limited', 429, 'Too many devices waiting to pair');
    }
    const pin = requestFirst ? undefined : newPin();
    const secret = issueToken();
    const id = randomUUID();
    pending.set(id, {
      id,
      pin,
      name,
      secretHash: secret.hash,
      expiresAt: Date.now() + lifetimeMs,
      requestFirst,
      attemptsRemaining: 5,
    });
    return { id, pin, secret: secret.token, expiresInSeconds: lifetimeMs / 1000 };
  }

  function verifyDevice(body: unknown, requestFirst: boolean): Pairing {
    prune();
    const payload = jsonObject(body);
    const entry = pending.get(requiredString(payload, 'id'));
    const secret = requiredString(payload, 'secret');
    if (
      !entry ||
      entry.requestFirst !== requestFirst ||
      secret.length > 128 ||
      hashToken(secret) !== entry.secretHash
    )
      throw unavailable();
    return entry;
  }

  function issueReadAccess(name: string, ownerId: string) {
    const issued = issueToken();
    const created = context.catalog.createDeviceToken({
      userId: ownerId,
      name,
      tokenHash: issued.hash,
      scopes: ['read'],
      expiresAt: new Date(Date.now() + tokenLifetimeMs).toISOString(),
    });
    return { id: created.id, token: issued.token, scopes: ['read'] };
  }

  function issueFor(entry: Pairing, ownerId: string) {
    const token = issueReadAccess(entry.name, ownerId);
    pending.delete(entry.id);
    return token;
  }

  const invitePath = '/api/v1/device-pairing/invitations';
  app.post(invitePath, async (request, reply) => {
    const owner = requireOwner(request, 'Sign in as the owner to invite a device');
    prune();
    if (invitations.size >= 128 || !context.limiter.allow(`pair-invite:${owner.userId}`)) {
      throw new DomainError('rate-limited', 429, 'Too many pairing invitations');
    }
    const id = randomUUID();
    const pin = String(randomInt(1_000_000)).padStart(6, '0');
    invitations.set(id, {
      ownerId: owner.userId,
      pin,
      expiresAt: Date.now() + lifetimeMs,
      attemptsRemaining: 5,
    });
    return reply
      .header('cache-control', 'no-store')
      .status(201)
      .send({
        id,
        pin,
        expiresInSeconds: lifetimeMs / 1000,
      });
  });
  app.delete<{ Params: { id: string } }>(`${invitePath}/:id`, async (request, reply) => {
    const owner = requireOwner(request, 'Sign in as the owner to withdraw an invitation');
    prune();
    if (invitations.get(request.params.id)?.ownerId !== owner.userId) throw unavailable();
    invitations.delete(request.params.id);
    return reply.header('cache-control', 'no-store').status(204).send();
  });
  app.post(`${invitePath}/redeem`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!context.limiter.allow(`pair-claim:${request.ip}`)) {
      throw new DomainError('rate-limited', 429, 'Too many pairing attempts');
    }
    prune();
    const body = jsonObject(request.body);
    const id = requiredString(body, 'id');
    const invite = invitations.get(id);
    if (!invite) throw unavailable();
    const name = deviceName(body);
    if (requiredString(body, 'pin') !== invite.pin) {
      if (--invite.attemptsRemaining === 0) invitations.delete(id);
      throw unavailable();
    }
    const token = issueReadAccess(name, invite.ownerId);
    invitations.delete(id);
    return reply.send(token);
  });

  const requests = '/api/v1/device-pairing/requests';
  app.post('/api/v1/device-pairing', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return reply.status(201).send(start(request.ip, request.body, false));
  });
  app.post(requests, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id, secret, expiresInSeconds } = start(request.ip, request.body, true);
    return reply.status(201).send({ id, secret, expiresInSeconds });
  });
  app.get(requests, async (request, reply) => {
    requireOwner(request, 'Sign in as the owner to pair a device');
    prune();
    return reply.header('cache-control', 'no-store').send({
      items: [...pending.values()]
        .filter((entry) => entry.requestFirst)
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          approved: !!entry.approvedBy,
          expiresAt: new Date(entry.expiresAt).toISOString(),
        })),
    });
  });
  app.post<{ Params: { id: string } }>(`${requests}/:id/approve`, async (request, reply) => {
    const owner = requireOwner(request, 'Sign in as the owner to pair a device');
    prune();
    const entry = pending.get(request.params.id);
    if (!entry?.requestFirst || (entry.approvedBy && entry.approvedBy !== owner.userId))
      throw unavailable();
    entry.pin ??= newPin();
    entry.approvedBy = owner.userId;
    return reply.header('cache-control', 'no-store').send({ pin: entry.pin });
  });
  app.delete<{ Params: { id: string } }>(`${requests}/:id`, async (request, reply) => {
    requireOwner(request, 'Sign in as the owner to dismiss a device request');
    prune();
    const entry = pending.get(request.params.id);
    if (!entry?.requestFirst) throw unavailable();
    pending.delete(entry.id);
    return reply.header('cache-control', 'no-store').status(204).send();
  });
  app.post(`${requests}/status`, async (request, reply) => {
    const entry = verifyDevice(request.body, true);
    return reply.header('cache-control', 'no-store').send({ approved: !!entry.approvedBy });
  });
  app.post(`${requests}/cancel`, async (request, reply) => {
    const entry = verifyDevice(request.body, true);
    pending.delete(entry.id);
    return reply.header('cache-control', 'no-store').status(204).send();
  });
  app.post(`${requests}/complete`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const entry = verifyDevice(request.body, true);
    if (!entry.approvedBy) return reply.status(202).send();
    const pin = requiredString(jsonObject(request.body), 'pin');
    if (pin !== entry.pin) {
      if (--entry.attemptsRemaining === 0) {
        pending.delete(entry.id);
        throw unavailable();
      }
      throw new DomainError('invalid-pairing-pin', 400, 'The pairing PIN did not match');
    }
    return reply.send(issueFor(entry, entry.approvedBy));
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
    const entry = verifyDevice(request.body, false);
    reply.header('cache-control', 'no-store');
    if (!entry.approvedBy) return reply.status(202).send();
    return reply.send(issueFor(entry, entry.approvedBy));
  });
}
