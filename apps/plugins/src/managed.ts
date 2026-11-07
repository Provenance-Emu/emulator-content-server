import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContentClient } from '@ecs/client';
import type { PluginConfiguration, PluginManagement } from '@ecs/protocol';
import { CLEANUP_MANIFEST, installBundledCleanup } from './workflows/bundled.js';
import {
  activateWorkflowPackage,
  activeWorkflowPackages,
  disableWorkflowPackage,
  listWorkflowPackages,
} from './workflows/packages.js';
import { openWorkflowState } from './workflows/state.js';
import { startWorkflowHost } from './workflows/transport.js';

interface Connection {
  hostId: string;
  token: string;
}

/** Runs entirely in the separate plugin host, using its existing immutable packages. */
export class ManagedPlugins {
  private connection: Connection | null = null;
  private controller: AbortController | null = null;
  private task: Promise<void> | null = null;
  private failure: string | null = null;
  constructor(
    private directory: string,
    private server: string,
  ) {}

  async initialize() {
    const state = await openWorkflowState(this.directory);
    state.close();
    try {
      const path = join(this.directory, 'connection.json');
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 8192 ||
        (process.platform !== 'win32' &&
          ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
      )
        throw new Error('Invalid private plugin connection');
      const value = JSON.parse(await readFile(path, 'utf8')) as Connection;
      if (
        typeof value.hostId !== 'string' ||
        !value.hostId ||
        value.hostId.length > 200 ||
        typeof value.token !== 'string' ||
        !/^[A-Za-z0-9_-]{20,200}$/.test(value.token)
      )
        throw new Error('Invalid private plugin connection');
      this.connection = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await this.doctor();
    } catch {
      this.failure = 'The plugin host could not connect. Run Check and repair connection.';
    }
  }

  async connect(connection: Connection) {
    if (
      typeof connection.hostId !== 'string' ||
      !connection.hostId ||
      connection.hostId.length > 200 ||
      typeof connection.token !== 'string' ||
      !/^[A-Za-z0-9_-]{20,200}$/.test(connection.token)
    )
      throw new Error('Invalid plugin connection');
    await this.stop();
    const pending = join(this.directory, `.connection-${randomUUID()}`);
    try {
      await writeFile(pending, JSON.stringify(connection), { flag: 'wx', mode: 0o600 });
      await rename(pending, join(this.directory, 'connection.json'));
      this.connection = connection;
    } finally {
      await rm(pending, { force: true });
    }
  }

  async defaults() {
    await installBundledCleanup(this.directory);
  }

  async configure(configuration: PluginConfiguration) {
    const installed = await listWorkflowPackages(this.directory);
    if (
      !installed.some(
        (item) => item.manifest.id === configuration.id && item.digest === configuration.digest,
      )
    )
      throw new Error('Plugin version is not installed');
    if (configuration.enabled)
      await activateWorkflowPackage(this.directory, configuration.id, configuration.digest);
    else await disableWorkflowPackage(this.directory, configuration.id);
  }

  async view(): Promise<PluginManagement> {
    const active = await activeWorkflowPackages(this.directory);
    const installed = await listWorkflowPackages(this.directory);
    if (installed.length > 200) throw new Error('Too many installed plugin versions');
    return {
      available: true,
      hostId: this.connection?.hostId ?? null,
      running: this.controller !== null && !this.controller.signal.aborted,
      error: this.failure,
      items: installed.map((item) => ({
        id: item.manifest.id,
        name: item.manifest.name,
        version: item.manifest.version,
        kind: item.manifest.kind,
        digest: item.digest,
        enabled: active.some(
          (current) => current.id === item.manifest.id && current.digest === item.digest,
        ),
      })),
      defaults: [
        {
          id: CLEANUP_MANIFEST.id,
          name: CLEANUP_MANIFEST.name,
          version: CLEANUP_MANIFEST.version,
          description:
            'Inspect your library for metadata and artwork problems, then review proposed fixes before applying them.',
        },
      ],
    };
  }

  async doctor() {
    const connection = this.connection;
    if (!connection) return;
    const client = new ContentClient(this.server, connection.token, { timeoutMs: 10_000 });
    const active = await activeWorkflowPackages(this.directory);
    await client.advertiseWorkflowHost(active);
    this.failure = null;
    if (active.length === 0) {
      await this.stop();
      return;
    }
    if (this.controller && !this.controller.signal.aborted) return;
    const controller = new AbortController();
    this.controller = controller;
    this.task = startWorkflowHost(
      {
        stateDirectory: this.directory,
        server: this.server,
        client: new ContentClient(this.server, connection.token, {
          signal: controller.signal,
          timeoutMs: 15_000,
        }),
      },
      controller.signal,
    )
      .catch(() => {
        if (!controller.signal.aborted)
          this.failure = 'The plugin host stopped. Run Check and repair connection.';
      })
      .finally(() => {
        if (this.controller === controller) this.controller = null;
      });
  }

  async stop() {
    this.controller?.abort();
    await this.task;
    this.task = null;
    this.controller = null;
  }
}

if (process.send) {
  const directory = process.argv[2];
  const server = process.argv[3];
  if (!directory || !server) throw new Error('Missing managed host configuration');
  const manager = new ManagedPlugins(directory, server);
  let queue = Promise.resolve();
  const stop = () => {
    void manager.stop().finally(() => process.exit(0));
  };
  process.once('disconnect', stop);
  process.once('SIGTERM', stop);
  await manager.initialize();
  process.send({ ready: true });
  process.on('message', (raw: unknown) => {
    queue = queue.then(async () => {
      const message = raw as {
        id?: string;
        operation?: string;
        configuration?: PluginConfiguration;
        hostId?: string;
        token?: string;
      };
      if (!message || typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id)) return;
      try {
        switch (message.operation) {
          case 'view':
            break;
          case 'defaults':
            await manager.defaults();
            break;
          case 'configure':
            if (!message.configuration) throw new Error('Missing plugin configuration');
            await manager.configure(message.configuration);
            break;
          case 'connect':
            if (!message.hostId || !message.token) throw new Error('Missing plugin connection');
            await manager.connect({ hostId: message.hostId, token: message.token });
            break;
          case 'doctor':
            await manager.doctor();
            break;
          default:
            throw new Error('Unknown operation');
        }
        process.send?.({ id: message.id, view: await manager.view() });
      } catch {
        process.send?.({
          id: message.id,
          error:
            'Plugin operation failed. Check the host connection and installed package state, then retry.',
        });
      }
    });
  });
}
