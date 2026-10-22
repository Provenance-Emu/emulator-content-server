import { DomainError } from '@ecs/domain';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './context.js';
import type { FolderWatcher } from './folder-watcher.js';
import { jsonObject, requireOwner } from './http.js';

export function registerFolderWatchRoutes(
  app: FastifyInstance,
  context: ServerContext,
  watcher: FolderWatcher,
): void {
  const { catalog } = context;
  function view(rootId: string) {
    const enabled = catalog.listFolderWatchPolicies().some((policy) => policy.rootId === rootId);
    return { rootId, enabled, ...watcher.status(rootId) };
  }
  app.get('/api/v1/roots/:rootId/watching-policy', async (request, reply) => {
    requireOwner(request, 'Only an owner can manage folder watching');
    const { rootId } = request.params as { rootId: string };
    if (!catalog.getContentRoot(rootId))
      throw new DomainError('not-found', 404, 'Folder not found');
    reply.header('cache-control', 'private, no-store');
    return view(rootId);
  });
  app.put('/api/v1/roots/:rootId/watching-policy', async (request, reply) => {
    const actor = requireOwner(request, 'Only an owner can manage folder watching');
    const { rootId } = request.params as { rootId: string };
    const body = jsonObject(request.body);
    if (typeof body.enabled !== 'boolean' || Object.keys(body).some((key) => key !== 'enabled'))
      throw new DomainError('invalid-body', 400, 'Supply only enabled as a boolean');
    if (!catalog.getContentRoot(rootId))
      throw new DomainError('not-found', 404, 'Folder not found');
    if (body.enabled) catalog.setFolderWatchPolicy(rootId, actor.userId);
    else catalog.clearFolderWatchPolicy(rootId);
    watcher.reconcile();
    reply.header('cache-control', 'private, no-store');
    return view(rootId);
  });
}
