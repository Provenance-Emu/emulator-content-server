import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isLoopbackAddress } from '@ecs/auth';
import type { FastifyInstance } from 'fastify';

/**
 * Holds `127.0.0.1` on the server's own port when the server listens on the home network.
 *
 * A server that listens on every address does not own the loopback address: another program on
 * the same computer can bind `127.0.0.1` on that port and receive what was meant for the server,
 * including the local owner key the desktop app sends. Binding it here closes that, and gives the
 * desktop app a listener it can verify belongs to this process. The same routes answer on it.
 *
 * Null when there is nothing to hold (the server already listens on loopback only) or the
 * address could not be bound. In the second case someone else has it, the desktop app's check
 * fails, and local sign-in stays off, which is the safe outcome.
 */
export async function holdLoopbackListener(app: FastifyInstance): Promise<Server | null> {
  const bound = app.server.address() as AddressInfo | string | null;
  if (!bound || typeof bound === 'string') return null;
  if (isLoopbackAddress(bound.address)) return null;
  const main = app.server;
  const loopback = createServer();
  loopback.keepAliveTimeout = main.keepAliveTimeout;
  loopback.headersTimeout = main.headersTimeout;
  loopback.requestTimeout = main.requestTimeout;
  loopback.timeout = main.timeout;
  // Everything a connection can ask for is answered by the one application.
  for (const event of ['request', 'upgrade', 'checkContinue', 'checkExpectation', 'clientError'])
    loopback.on(event, (...args: unknown[]) => main.emit(event, ...args));
  return new Promise((resolve) => {
    loopback.once('error', () => resolve(null));
    loopback.listen(bound.port, '127.0.0.1', () => {
      loopback.removeAllListeners('error');
      // A late socket error must not take the server down.
      loopback.on('error', () => {});
      resolve(loopback);
    });
  });
}

export function closeLoopbackListener(loopback: Server | null): Promise<void> {
  if (!loopback) return Promise.resolve();
  return new Promise((resolve) => {
    loopback.close(() => resolve());
    loopback.closeAllConnections();
  });
}
