import { type ContentClient, ContentError, type Item, type UploadRequest } from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { explain } from './problems.js';
import type { UploadReviewEntry } from './upload-review.js';
import { uploadIdentity } from './upload-review.js';
export interface UploadQueueEntry extends UploadReviewEntry {
  state: 'waiting' | 'uploading' | 'succeeded' | 'failed' | 'reconciliation-required';
  sent: number;
  failure: string | null;
  idempotencyKey: string;
  request: UploadRequest | null;
}
export interface UploadQueueState {
  entries: UploadQueueEntry[];
  visible: UploadQueueEntry[];
  page: number;
  pages: number;
  running: boolean;
  stopping: boolean;
  status: number | null;
}
export interface UploadQueue extends Readable<UploadQueueState> {
  start(entries: UploadReviewEntry[]): Promise<void>;
  stopAfterCurrent(): void;
  retryUnfinished(): Promise<void>;
  reconcile(id: string, item: Item): void;
  page(index: number): void;
  dispose(): void;
}
export function createUploadQueue(
  client: ContentClient,
  context: {
    libraryId: string;
    changed?: () => void;
    authorizationRejected?: (status: 401 | 403) => void;
  },
): UploadQueue {
  let current: UploadQueueState = {
    entries: [],
    visible: [],
    page: 0,
    pages: 1,
    running: false,
    stopping: false,
    status: null,
  };
  const store = writable(current);
  let disposed = false;
  let started = false;
  const touched = new Set<string>();
  function publish(patch: Partial<UploadQueueState> = {}) {
    if (disposed) return;
    current = { ...current, ...patch };
    current = {
      ...current,
      entries: [...current.entries],
      visible: current.entries.slice(current.page * 50, current.page * 50 + 50),
      pages: Math.max(1, Math.ceil(current.entries.length / 50)),
    };
    store.set(current);
  }
  async function run() {
    if (disposed || current.running) return;
    publish({ running: true, stopping: false, status: null });
    try {
      for (const e of current.entries) {
        if (disposed || current.stopping) break;
        if (e.state === 'succeeded' || e.state === 'reconciliation-required') continue;
        e.state = 'uploading';
        e.failure = null;
        publish();
        let creationUncertain = false;
        try {
          if (!e.target) {
            try {
              const created = await client.createItem({
                libraryId: context.libraryId,
                title: e.title.trim(),
                systemIdentifier: e.system,
              });
              if (disposed) return;
              e.target = created;
            } catch (error) {
              // Creation has no idempotency contract; an unknown response must be reconciled by the operator.
              if (!(error instanceof ContentError) || error.status >= 500) creationUncertain = true;
              throw error;
            }
          }
          if (disposed) return;
          if (!e.request) {
            let revision = e.target.revision;
            if (touched.has(e.target.id)) {
              const manifest = await client.manifest(e.target.id);
              if (disposed) return;
              if (
                manifest.itemId !== e.target.id ||
                !Number.isSafeInteger(manifest.revision) ||
                manifest.revision < 1
              )
                throw new Error('Invalid item manifest');
              revision = manifest.revision;
            }
            touched.add(e.target.id);
            e.request = {
              libraryId: context.libraryId,
              itemId: e.target.id,
              kind: e.kind,
              displayName: e.file.name,
              relativePath: e.relativePath,
              baseRevision: revision,
              body: e.file,
              idempotencyKey: e.idempotencyKey,
              chunkBytes: 4 * 1024 * 1024,
              onProgress(sent) {
                if (!disposed) {
                  e.sent = sent;
                  publish();
                }
              },
            };
          }
          // Reuse this exact request on retry, including the original save baseline.
          await client.upload(e.request);
          if (disposed) return;
          e.state = 'succeeded';
          e.sent = e.file.size;
          publish();
          context.changed?.();
        } catch (error) {
          if (disposed) return;
          e.state = creationUncertain ? 'reconciliation-required' : 'failed';
          e.failure = explain(error);
          const status = error instanceof ContentError ? error.status : null;
          publish({ status });
          if (status === 401 || status === 403) {
            publish({ stopping: true });
            context.authorizationRejected?.(status);
            break;
          }
        }
      }
    } finally {
      publish({ running: false });
    }
  }
  return {
    subscribe: store.subscribe,
    start(entries) {
      if (
        disposed ||
        started ||
        !entries.length ||
        entries.some(
          (e) => e.errors.length || (e.target && e.target.libraryId !== context.libraryId),
        )
      )
        return Promise.resolve();
      started = true;
      publish({
        entries: entries.map((e) => ({
          ...e,
          state: 'waiting',
          sent: 0,
          failure: null,
          idempotencyKey: uploadIdentity(),
          request: null,
        })),
      });
      return run();
    },
    stopAfterCurrent() {
      if (current.running) publish({ stopping: true });
    },
    retryUnfinished: run,
    reconcile(id, item) {
      if (disposed || current.running || item.libraryId !== context.libraryId) return;
      const e = current.entries.find((e) => e.id === id);
      if (e?.state !== 'reconciliation-required') return;
      e.target = item;
      e.state = 'waiting';
      e.failure = null;
      publish();
    },
    page(index) {
      publish({ page: Math.max(0, Math.min(index, current.pages - 1)) });
    },
    dispose() {
      disposed = true;
    },
  };
}
