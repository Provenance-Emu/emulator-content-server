import { trustedLevel } from '@ecs/auth';
import type { Actor } from '@ecs/domain';
import type { FastifyRequest } from 'fastify';
import type { ServerContext } from './context.js';

/**
 * The menu bar is a different origin from the API. Only that window may read
 * responses. A wildcard would let any website act as this Mac, because loopback
 * is trusted without a token.
 */
export function trayOrigin(origin: string | undefined): boolean {
  return (
    origin !== undefined &&
    new Set([
      'tauri://localhost',
      'http://tauri.localhost',
      'https://tauri.localhost',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    ]).has(origin)
  );
}

/** The socket address. Forwarded headers are ignored so a client cannot pick its own. */
export function peerAddress(request: FastifyRequest): string {
  const remote = request.socket?.remoteAddress;
  if (typeof remote === 'string' && remote.length > 0) return remote;
  return request.ip;
}

/**
 * A trusted socket with no token. Nothing is admitted before an owner exists,
 * and a server started for the public internet never takes this path.
 */
export function admitLocal(context: ServerContext, request: FastifyRequest): Actor | null {
  if (!context.localTrust || !context.catalog.server().bootstrapped) return null;
  const policy = context.catalog.accessPolicy();
  const level = trustedLevel(policy.mode, policy.subnets, peerAddress(request));
  if (!level) return null;
  return context.catalog.localActor(level);
}

export function accessView(
  context: ServerContext,
  request: FastifyRequest,
): {
  mode: 'lan' | 'token' | 'subnets';
  subnets: string[];
  applies: boolean;
  trusted: boolean;
  manages: boolean;
} {
  const policy = context.catalog.accessPolicy();
  const level =
    context.localTrust && context.catalog.server().bootstrapped
      ? trustedLevel(policy.mode, policy.subnets, peerAddress(request))
      : null;
  return {
    mode: policy.mode,
    subnets: policy.subnets,
    applies: context.localTrust,
    trusted: level !== null,
    manages: level === 'owner',
  };
}
