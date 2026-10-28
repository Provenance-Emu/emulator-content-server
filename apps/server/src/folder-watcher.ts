import { type FSWatcher, realpathSync, statSync, watch } from 'node:fs';
import type { CatalogDatabase } from '@ecs/database';
import { DomainError } from '@ecs/domain';
import { enqueueRootScan } from './library-jobs.js';

export interface FolderWatchStatus {
  state: 'off' | 'watching' | 'polling' | 'offline' | 'scanning' | 'error';
  lastScanAt?: string;
  warning?: string;
}
interface WatchedFolder {
  rootId: string;
  rootPath: string;
  enabledBy: string;
  watcher?: FSWatcher;
  due: number | null;
  firstEvent?: number;
  nextAudit: number;
  watchIdentity?: string;
  status: FolderWatchStatus;
}

/** Events are hints, never paths or move evidence. Only the existing verified scanner
 * updates records. One queue serializes automatic scans, including sibling roots. */
export class FolderWatcher {
  private readonly folders = new Map<string, WatchedFolder>();
  private timer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;
  private running?: Promise<void>;
  private closed = false;

  constructor(private readonly catalog: CatalogDatabase) {}

  status(rootId: string): FolderWatchStatus {
    return { ...(this.folders.get(rootId)?.status ?? { state: 'off' }) };
  }

  reconcile(): void {
    if (this.closed) return;
    const policies = this.catalog
      .listFolderWatchPolicies()
      .filter((policy) => this.catalog.getContentRoot(policy.rootId)?.path === policy.rootPath);
    const desired = new Map(policies.map((policy) => [policy.rootId, policy]));
    for (const [id, folder] of this.folders) {
      const policy = desired.get(id);
      if (!policy || policy.rootPath !== folder.rootPath || policy.enabledBy !== folder.enabledBy) {
        folder.watcher?.close();
        this.folders.delete(id);
      }
    }
    for (const policy of policies) {
      if (this.folders.has(policy.rootId)) continue;
      const folder: WatchedFolder = {
        ...policy,
        due: Date.now(),
        nextAudit: 0,
        status: { state: 'polling' },
      };
      this.folders.set(policy.rootId, folder);
      this.attach(folder);
    }
    if (this.folders.size && !this.interval) {
      // Recover missed OS events, unavailable roots, exhausted watch resources, and
      // roots replaced at the same path. This also reconciles deleted policies.
      this.interval = setInterval(() => {
        this.reconcile();
        for (const folder of this.folders.values()) {
          if (folder.watcher && this.identity(folder.rootPath) !== folder.watchIdentity) {
            folder.watcher.close();
            folder.watcher = undefined;
            folder.due ??= Date.now();
          }
          if (!folder.watcher) this.attach(folder);
          if (Date.now() >= folder.nextAudit) folder.due ??= Date.now();
        }
        this.kick();
      }, 30_000);
      this.interval.unref();
    } else if (!this.folders.size && this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.kick();
  }

  private identity(path: string): string | undefined {
    try {
      if (realpathSync(path) !== path) return undefined;
      const info = statSync(path, { bigint: true });
      return info.isDirectory() ? `${info.dev}:${info.ino}` : undefined;
    } catch {
      return undefined;
    }
  }

  private attach(folder: WatchedFolder): void {
    const fallback = () => {
      folder.watcher?.close();
      folder.watcher = undefined;
      folder.status = {
        ...folder.status,
        state: 'polling',
        warning: 'Live notifications unavailable. Checking this folder periodically.',
      };
    };
    try {
      const identity = this.identity(folder.rootPath);
      if (!identity) {
        fallback();
        return;
      }
      folder.watcher = watch(folder.rootPath, { recursive: true, persistent: false }, () => {
        if (this.closed || this.folders.get(folder.rootId) !== folder) return;
        const now = Date.now();
        folder.firstEvent ??= now;
        // Coalesce bursts but do not starve scans while files keep changing.
        folder.due = Math.min(now + 250, folder.firstEvent + 2_000);
        this.kick();
      });
      folder.watcher.on('error', () => {
        if (this.closed || this.folders.get(folder.rootId) !== folder) return;
        fallback();
        folder.due ??= Date.now() + 250;
        this.kick();
      });
      folder.watchIdentity = identity;
      folder.status = { ...folder.status, state: 'watching', warning: undefined };
    } catch {
      fallback();
    }
  }

  private kick(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.running) return;
    const pending = [...this.folders.values()].flatMap((folder) =>
      folder.due === null ? [] : [folder.due],
    );
    if (!pending.length) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.running = Promise.resolve()
          .then(() => this.drain())
          .finally(() => {
            this.running = undefined;
            this.kick();
          });
      },
      Math.max(0, Math.min(...pending) - Date.now()),
    );
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      // Also observe preference changes made through another catalog handle.
      this.reconcile();
      const folder = [...this.folders.values()]
        .filter((entry) => entry.due !== null && entry.due <= Date.now())
        .sort((a, b) => (a.due ?? 0) - (b.due ?? 0))[0];
      if (!folder) return;
      folder.due = null;
      folder.firstEvent = undefined;
      folder.status.state = 'scanning';
      const started = Date.now();
      try {
        const result = await enqueueRootScan(
          this.catalog,
          { id: folder.rootId, path: folder.rootPath },
          folder.enabledBy,
        );
        // Healthy OS watchers need occasional missed-event recovery, not a full walk
        // every poll. Slow fallback scans get breathing room proportional to IO cost.
        folder.nextAudit =
          Date.now() +
          (result.online && folder.watcher
            ? 15 * 60_000
            : Math.max(30_000, Math.min(5 * 60_000, (Date.now() - started) * 10)));
        folder.status = {
          state: result.online ? (folder.watcher ? 'watching' : 'polling') : 'offline',
          lastScanAt: new Date().toISOString(),
          ...(!result.online
            ? { warning: 'Folder is offline. Retrying every 30 seconds.' }
            : !folder.watcher
              ? {
                  warning: 'Live notifications unavailable. Checking this folder periodically.',
                }
              : {}),
        };
      } catch (error) {
        folder.nextAudit = Date.now() + 30_000;
        if (
          error instanceof DomainError &&
          ['root-busy', 'library-job-conflict'].includes(error.code)
        ) {
          folder.status.state = folder.watcher ? 'watching' : 'polling';
          folder.due ??= Date.now() + 500;
        } else {
          folder.status = {
            ...folder.status,
            state: 'error',
            warning: 'Folder could not be checked. Retrying every 30 seconds.',
          };
        }
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    for (const folder of this.folders.values()) folder.watcher?.close();
    this.folders.clear();
    await this.running;
  }
}
