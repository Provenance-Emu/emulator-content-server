import { DigestAuthority, hashToken } from '@ecs/auth';
import { DomainError } from '@ecs/domain';
import { handleDav } from '@ecs/webdav';
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { sendContent, sendSourceContent } from './content.js';
import type { ServerContext } from './context.js';
import { peerAddress } from './local-access.js';
import { createDavNamespace } from './webdav-namespace.js';

export function isDavRequest(url: string): boolean {
  const path = url.split('?')[0];
  return path === '/dav' || path?.startsWith('/dav/') === true;
}
export function davAuthenticator(context: ServerContext) {
  const authority = new DigestAuthority();
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    request.actor = null;
    const header = request.headers.authorization;
    let stale = false;
    if (header) {
      const bearer = /^Bearer\s+(\S+)$/i.exec(header);
      if (bearer?.[1]) request.actor = context.catalog.authenticate(hashToken(bearer[1]));
      else if (/^Digest /i.test(header)) {
        const found = {
          credential: null as ReturnType<typeof context.catalog.findWebDavCredential>,
        };
        const result = authority.verify(
          { header, method: request.method, uri: request.raw.url ?? request.url },
          (username) => {
            found.credential = context.catalog.findWebDavCredential(username);
            return found.credential;
          },
        );
        if (result.kind === 'full')
          throw new DomainError('rate-limited', 503, 'Authentication is busy');
        stale = result.kind === 'stale';
        if (result.kind === 'ok' && found.credential?.id === result.credentialId) {
          const credential = found.credential;
          request.actor = {
            kind: 'user',
            userId: credential.userId,
            username: credential.accountUsername,
            isOwner: credential.isOwner,
            tokenKind: 'device',
            deviceId: credential.id,
            scopes: ['read'],
          };
        }
      }
    }
    if (request.actor) return;
    if (header && !stale && !context.limiter.allow(`dav:${peerAddress(request)}`)) {
      throw new DomainError('rate-limited', 429, 'Too many authentication attempts');
    }
    reply.header('www-authenticate', [
      ...authority.challenges(stale),
      'Bearer realm="Emulator Content Server WebDAV"',
    ]);
    throw new DomainError('unauthorized', 401, 'WebDAV credentials are required');
  };
}
export function registerWebDav(app: FastifyInstance, context: ServerContext): void {
  if (!context.webdavEnabled) return;
  for (const method of ['PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK']) {
    app.addHttpMethod(method, { hasBody: true });
  }
  app.register(async (dav) => {
    dav.addContentTypeParser(
      ['application/xml', 'text/xml'],
      { parseAs: 'string', bodyLimit: 32768 },
      (_request, body, done) => done(null, body),
    );
    dav.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 32768 }, (_request, body, done) =>
      done(null, body),
    );
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.actor;
      if (!actor) throw new DomainError('unauthorized', 401, 'Authentication is required');
      if (request.body !== undefined && typeof request.body !== 'string')
        throw new DomainError('invalid-body', 400, 'Expected XML');
      const response = await handleDav(
        {
          method: request.method,
          url: request.raw.url ?? request.url,
          depth: typeof request.headers.depth === 'string' ? request.headers.depth : undefined,
          body: request.body as string | undefined,
        },
        createDavNamespace(context, actor),
      );
      reply.headers(response.headers).header('cache-control', 'private, no-cache');
      if (response.file?.id)
        return response.file.kind === 'asset'
          ? sendContent(context, request, reply, response.file.id)
          : sendSourceContent(context, request, reply, response.file.id);
      return reply.code(response.status).send(response.body ?? '');
    };
    // Fastify's method union omits runtime methods registered with addHttpMethod.
    const methods = [
      'GET',
      'HEAD',
      'OPTIONS',
      'POST',
      'PATCH',
      'PUT',
      'DELETE',
      'PROPFIND',
      'PROPPATCH',
      'MKCOL',
      'COPY',
      'MOVE',
      'LOCK',
      'UNLOCK',
    ] as HTTPMethods[];
    for (const url of ['/dav', '/dav/', '/dav/*'])
      dav.route({ method: methods, url, bodyLimit: 32768, handler });
  });
}
