import { type ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { PluginConfiguration, PluginManagement } from '@ecs/protocol';
import type { PluginManagementBridge } from '@ecs/server';

/** Launches the bundled sibling package over private IPC. No plugin code is imported here. */
export class ManagedPluginHost implements PluginManagementBridge {
  private child: ChildProcess | null = null;
  private ready: Promise<ChildProcess> | null = null;
  private closed = false;
  private request: {
    id: string;
    resolve: (view: PluginManagement) => void;
    reject: (error: Error) => void;
  } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private directory: string,
    private server: string,
    private entry = fileURLToPath(new URL('../../../plugins/dist/src/managed.js', import.meta.url)),
  ) {}

  private async launch(): Promise<ChildProcess> {
    if (this.closed) throw new Error('Plugin host is shutting down');
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const info = await lstat(this.entry);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('Bundled plugin host is unavailable');
      if (this.closed) throw new Error('Plugin host is shutting down');
      const child = fork(this.entry, [this.directory, this.server], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: ['--disable-warning=ExperimentalWarning'],
        env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' },
      });
      this.child = child;
      child.on('message', (raw: unknown) => {
        const message = raw as { id?: unknown; view?: PluginManagement; error?: unknown };
        const request = this.request;
        if (!request || message?.id !== request.id) return;
        if (typeof message.error === 'string') request.reject(new Error(message.error));
        else if (
          message.view &&
          typeof message.view.available === 'boolean' &&
          Array.isArray(message.view.items)
        )
          request.resolve(message.view);
        else request.reject(new Error('Plugin host returned invalid status'));
      });
      const stopped = () => {
        if (this.child !== child) return;
        this.child = null;
        this.ready = null;
        this.request?.reject(new Error('Plugin host stopped. Run Check and repair connection.'));
      };
      child.once('exit', stopped);
      child.once('error', stopped);
      return await new Promise<ChildProcess>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Plugin host startup timed out'));
        }, 20_000);
        const ready = (raw: unknown) => {
          if ((raw as { ready?: unknown })?.ready !== true) return;
          clearTimeout(timer);
          child.off('message', ready);
          resolve(child);
        };
        child.on('message', ready);
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Plugin host could not start'));
        });
        child.once('error', () => {
          clearTimeout(timer);
          reject(new Error('Plugin host could not start'));
        });
      });
    })().catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private call(operation: string, fields: Record<string, unknown> = {}): Promise<PluginManagement> {
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        const child = await this.launch();
        return await new Promise<PluginManagement>((resolve, reject) => {
          const id = randomUUID();
          const timer = setTimeout(() => {
            this.request?.reject(
              new Error('Plugin operation timed out. Refresh plugins before retrying.'),
            );
            child.kill('SIGKILL');
          }, 30_000);
          const finish = () => {
            clearTimeout(timer);
            this.request = null;
          };
          this.request = {
            id,
            resolve: (view) => {
              finish();
              resolve(view);
            },
            reject: (error) => {
              finish();
              reject(error);
            },
          };
          child.send({ id, operation, ...fields }, (error) => {
            if (error && this.request?.id === id)
              this.request.reject(new Error('Plugin host disconnected'));
          });
        });
      });
    this.queue = work;
    return work;
  }
  view() {
    return this.call('view');
  }
  async installDefaults() {
    await this.call('defaults');
  }
  async configure(configuration: PluginConfiguration) {
    await this.call('configure', { configuration });
  }
  async connect(hostId: string, token: string) {
    await this.call('connect', { hostId, token });
  }
  async doctor() {
    await this.call('doctor');
  }
  async close() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.connected) child.disconnect();
      else child.kill();
    });
  }
}
