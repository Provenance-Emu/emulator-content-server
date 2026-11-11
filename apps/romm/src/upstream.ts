import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseOrigin(address: string): URL {
  const url = new URL(address);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('ECS_SERVER must be an HTTP(S) origin without credentials or a path');
  return url;
}

export class Upstream {
  readonly signal: AbortSignal;
  private readonly authorization: string;

  constructor(
    private readonly origin: URL,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const auth = request.headers.authorization;
    if (!auth || !/^Bearer [^\s]{1,1024}$/.test(auth))
      throw new GatewayError(
        401,
        'Enter an ECS read token in the RomM password field and leave the username blank.',
      );
    this.authorization = auth;
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());
    this.signal = controller.signal;
  }

  async get(path: string, options: { head?: boolean; headers?: Headers } = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set('authorization', this.authorization);
    // Forwarded range and length headers describe the original bytes.
    headers.set('accept-encoding', 'identity');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      return await fetch(new URL(`/api/v1/${path}`, this.origin), {
        method: options.head ? 'HEAD' : 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.any([this.signal, controller.signal]),
      });
    } catch {
      throw new GatewayError(502, 'Could not reach Emulation Server.');
    } finally {
      clearTimeout(timer);
    }
  }

  async json<T>(path: string): Promise<T> {
    const response = await this.get(path);
    if (!response.ok) await this.reject(response);
    try {
      return (await response.json()) as T;
    } catch {
      throw new GatewayError(502, 'Emulation Server returned invalid metadata.');
    }
  }

  async reject(response: Response): Promise<never> {
    await response.body?.cancel();
    const status = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw new GatewayError(status, 'Emulation Server could not serve this resource.');
  }
}

export function readable(response: Response): Readable {
  if (!response.body) throw new GatewayError(502, 'Emulation Server returned no content.');
  return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
}
