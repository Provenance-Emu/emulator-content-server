import { DomainError } from '@ecs/domain';

export interface ListenPolicy {
  host: string;
  bootstrapped: boolean;
  allowUnconfiguredLan: boolean;
  publicInternet: boolean;
  tlsTerminated: boolean;
}

function isLoopback(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

export function assertListenPolicy(policy: ListenPolicy): void {
  if (policy.publicInternet && !policy.tlsTerminated) {
    throw new DomainError(
      'tls-required',
      400,
      'Public exposure requires a TLS-terminating reverse proxy',
    );
  }
  if (isLoopback(policy.host)) return;
  if (!policy.bootstrapped && !policy.allowUnconfiguredLan) {
    throw new DomainError(
      'lan-bind-blocked',
      400,
      'Finish bootstrap or set ECS_ALLOW_LAN=1 before binding beyond loopback',
    );
  }
}
