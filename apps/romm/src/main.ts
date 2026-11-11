import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openGateway } from './gateway.js';

const port = Number(process.env.ROMM_GATEWAY_PORT ?? '8474');
const host = process.env.ROMM_GATEWAY_HOST ?? '127.0.0.1';
const path = resolve(process.env.ROMM_GATEWAY_INDEX ?? 'romm-gateway.sqlite');
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid ROMM_GATEWAY_PORT.');
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
process.umask(0o077);
const app = openGateway({
  origin: process.env.ECS_SERVER ?? 'http://127.0.0.1:8473',
  indexPath: path,
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}
const address = await app.listen({ host, port });
console.log(`RomM compatibility gateway listening on ${address}`);
