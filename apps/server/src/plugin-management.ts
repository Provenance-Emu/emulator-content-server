import { issueToken } from '@ecs/auth';
import { DomainError } from '@ecs/domain';
import type { PluginConfiguration, PluginManagement } from '@ecs/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from './context.js';
import { jsonObject, requireOwner } from './http.js';

/** Only the launcher supplies this port. Native packages stay in the plugin process. */
export interface PluginManagementBridge {
  view(): Promise<PluginManagement>;
  installDefaults(): Promise<void>;
  configure(configuration: PluginConfiguration): Promise<void>;
  connect(hostId: string, token: string): Promise<void>;
  doctor(): Promise<void>;
}

export function registerPluginManagement(
  app: FastifyInstance,
  context: ServerContext,
  bridge?: PluginManagementBridge,
) {
  // Serialize installation and credential provisioning as one operation.
  let pending = false;
  async function connected(manager: PluginManagementBridge) {
    const view = await manager.view();
    const host = view.hostId ? context.catalog.workflowIdentities.getHost(view.hostId) : null;
    if (host?.enrolled && !host.revokedAt) return;
    const owner = context.catalog.listUsers().find((user) => user.isOwner);
    if (!owner)
      throw new DomainError('conflict', 409, 'Finish server setup before installing plugins.');
    const enrollment = issueToken();
    const created = context.catalog.workflowIdentities.createHost(
      owner.id,
      'This server',
      enrollment.hash,
      Date.now() + 60_000,
    );
    const credential = issueToken();
    context.catalog.workflowIdentities.enrollHost(enrollment.hash, credential.hash);
    try {
      await manager.connect(created.id, credential.token);
    } catch (error) {
      context.catalog.workflowIdentities.revokeHost(created.id, owner.id);
      throw error;
    }
  }
  const owner = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.headers.authorization)
      throw new DomainError('forbidden', 403, 'Sign in as the server owner to manage plugins');
    requireOwner(request, 'Sign in as the server owner to manage plugins');
    reply.header('cache-control', 'private, no-store');
  };
  app.get('/api/v1/plugins', { onRequest: owner }, async () =>
    bridge
      ? bridge.view()
      : {
          available: false,
          hostId: null,
          running: false,
          error: null,
          items: [],
          defaults: [],
        },
  );
  async function change(work: (manager: PluginManagementBridge) => Promise<void>) {
    if (!bridge)
      throw new DomainError(
        'plugin-host-unavailable',
        503,
        'The plugin host is not included in this server installation.',
      );
    if (pending)
      throw new DomainError(
        'plugin-management-busy',
        409,
        'Another plugin change is still running. Refresh plugins when it finishes.',
      );
    pending = true;
    try {
      await work(bridge);
      return await bridge.view();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'plugin-operation-failed',
        503,
        'The plugin operation could not finish. Refresh plugins, then use Check and repair connection.',
      );
    } finally {
      pending = false;
    }
  }
  app.post('/api/v1/plugins/defaults', { onRequest: owner }, async () =>
    change(async (manager) => {
      await manager.installDefaults();
      await connected(manager);
      await manager.doctor();
    }),
  );
  app.post('/api/v1/plugins/doctor', { onRequest: owner }, async () =>
    change(async (manager) => {
      await connected(manager);
      await manager.doctor();
    }),
  );
  app.patch('/api/v1/plugins', { onRequest: owner }, async (request) => {
    const body = jsonObject(request.body);
    if (
      Object.keys(body).some((key) => !['id', 'digest', 'enabled'].includes(key)) ||
      typeof body.id !== 'string' ||
      !/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(body.id) ||
      body.id.length > 200 ||
      typeof body.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.digest) ||
      typeof body.enabled !== 'boolean'
    )
      throw new DomainError(
        'invalid-body',
        400,
        'Choose an installed plugin version and enable or disable it.',
      );
    return change(async (manager) => {
      await manager.configure(body as unknown as PluginConfiguration);
      await connected(manager);
      await manager.doctor();
    });
  });
}
