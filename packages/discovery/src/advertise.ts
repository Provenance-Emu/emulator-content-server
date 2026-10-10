import { Bonjour } from 'bonjour-service';
import { buildDiscoveryTxt, type DiscoveryTxt, SERVICE_TYPE } from './txt.js';

export interface Advertisement {
  stop(): void;
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
