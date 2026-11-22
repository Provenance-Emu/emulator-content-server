import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { FastifyInstance } from 'fastify';

const brotli = promisify(brotliCompress);
const deflate = promisify(gzip);
/** Below this a listing fits in one packet and compressing it saves nothing. */
const SMALLEST = 1024;

/** The encoding to answer with, honouring `q=0`. Brotli first: it is smaller and every current client has it. */
export function acceptedEncoding(header: string | undefined): 'br' | 'gzip' | null {
  if (!header) return null;
  const accepted = new Set<string>();
  for (const part of header.split(',')) {
    const [name, ...parameters] = part.trim().toLowerCase().split(';');
    const quality = parameters.map((value) => value.trim()).find((value) => value.startsWith('q='));
    if (name && !(quality && Number(quality.slice(2)) === 0)) accepted.add(name);
  }
  return accepted.has('br') ? 'br' : accepted.has('gzip') ? 'gzip' : null;
}

/**
 * Compresses JSON that a client reads. See docs/superpowers/specs/2026-11-21-transfer-performance-design.md.
 *
 * Only `GET` answers are touched. Everything that hands out a credential is a `POST`, so no
 * token is ever compressed beside input someone else chose. A response marked `no-store`
 * is left alone as well. File content never reaches here as text: it is streamed, already
 * compressed by its format, and has to keep its byte ranges.
 */
export function registerJsonCompression(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'GET' || typeof payload !== 'string' || payload.length < SMALLEST)
      return payload;
    if (reply.statusCode !== 200 || reply.hasHeader('content-encoding')) return payload;
    if (!/^application\/(?:[\w.-]+\+)?json\b/.test(String(reply.getHeader('content-type') ?? '')))
      return payload;
    if (/\bno-store\b/.test(String(reply.getHeader('cache-control') ?? ''))) return payload;
    // A cache must not hand a compressed answer to a client that did not ask for one.
    const vary = String(reply.getHeader('vary') ?? '');
    if (!/\baccept-encoding\b/i.test(vary))
      reply.header('vary', vary ? `${vary}, accept-encoding` : 'accept-encoding');
    const encoding = acceptedEncoding(request.headers['accept-encoding']?.toString());
    if (!encoding) return payload;
    const body =
      encoding === 'br'
        ? await brotli(payload, {
            params: {
              // Quality 4 is close to gzip's speed and already smaller than gzip's best.
              [constants.BROTLI_PARAM_QUALITY]: 4,
              [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
              [constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(payload),
            },
          })
        : await deflate(payload, { level: 6 });
    reply.header('content-encoding', encoding);
    reply.removeHeader('content-length');
    return body;
  });
}
