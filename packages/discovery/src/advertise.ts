import { hostname } from 'node:os';
import { Bonjour } from 'bonjour-service';
import { buildDiscoveryTxt, type DiscoveryTxt, SERVICE_TYPE } from './txt.js';

export interface Advertisement {
  stop(): void;
}

/** A short OS hostname needs a Bonjour domain in the SRV target. */
export function bonjourTarget(host: string): string {
  const name = host.replace(/\.$/, '');
  return name.includes('.') ? name : `${name}.local`;
}

export function advertise(input: {
  displayName: string;
  port: number;
  serverId: string;
  tls: boolean;
  pairing: boolean;
}): Advertisement {
  const txt: DiscoveryTxt = buildDiscoveryTxt(input);
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: txt.name,
    type: SERVICE_TYPE,
    host: bonjourTarget(hostname()),
    port: input.port,
    txt,
  });
  return {
    stop() {
      service.stop();
      bonjour.destroy();
    },
  };
}
