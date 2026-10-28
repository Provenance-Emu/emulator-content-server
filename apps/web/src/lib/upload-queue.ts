import { type ContentClient, ContentError, type Item, type UploadRequest } from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { fingerprintFile } from './file-fingerprint.js';
import { explain } from './problems.js';
import {
  MAX_SAVED_UPLOADS,
  parseUploadCheckpoint,
  type UploadCheckpoint,
  type UploadCheckpointRecord,
  type UploadJournal,
} from './upload-checkpoint.js';
import type { UploadReviewEntry } from './upload-review.js';
import { uploadIdentity } from './upload-review.js';

export interface UploadQueueEntry extends Omit<UploadReviewEntry, 'file'> {
  file: File | null;
  name: string;
  size: number;
  sha256: string | null;
  state: 'waiting' | 'uploading' | 'succeeded' | 'failed' | 'reconciliation-required';
  sent: number;
  failure: string | null;
  idempotencyKey: string;
  request: UploadRequest | null;
  baseRevision: number | null;
}
export interface UploadQueueState {
  entries: UploadQueueEntry[];
  visible: UploadQueueEntry[];
  page: number;
  pages: number;
  running: boolean;
  stopping: boolean;
  status: number | null;
  checking: string | null;
  remembering: boolean;
  recoverable: boolean;
  failure: string | null;
}
export interface UploadQueue extends Readable<UploadQueueState> {
  start(entries: UploadReviewEntry[], remember?: boolean): Promise<void>;
  restore(record: UploadCheckpointRecord): void;
  attachFiles(files: File[]): Promise<void>;
  forgetProgress(): Promise<void>;
  stopAfterCurrent(): void;
  retryUnfinished(): Promise<void>;
  reconcile(id: string, item: Item): Promise<void>;
  page(index: number): void;
  dispose(): void;
}
class CheckpointFailure extends Error {}
export function createUploadQueue(
  client: ContentClient,
  context: {
    libraryId: string;
    itemId?: string | null;
    journal?: UploadJournal | null;
    isCurrent?: () => boolean;
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
    checking: null,
    remembering: false,
    recoverable: false,
    failure: null,
  };
  const store = writable(current);
  let disposed = false;
  let started = false;
  let revision: number | null = null;
  const touched = new Set<string>();
  const live = () => !disposed && (context.isCurrent?.() ?? true);
  function publish(patch: Partial<UploadQueueState> = {}) {
    if (disposed) return;
    if (!(context.isCurrent?.() ?? true)) {
      disposed = true;
      current = {
        ...current,
        entries: [],
        visible: [],
        running: false,
        checking: null,
        stopping: true,
        failure: 'The signed-in session changed. Close uploads and reload this library.',
      };
      store.set(current);
      return;
    }
    current = { ...current, ...patch };
    current = {
      ...current,
      entries: [...current.entries],
      visible: current.entries.slice(current.page * 50, current.page * 50 + 50),
      pages: Math.max(1, Math.ceil(current.entries.length / 50)),
    };
    store.set(current);
  }
  function snapshot(): UploadCheckpoint {
    return {
      version: 1,
      libraryId: context.libraryId,
      itemId: context.itemId ?? null,
      touched: [...touched],
      entries: current.entries.map((e) => {
        if (!e.sha256) throw new Error('File verification is incomplete.');
        return {
          id: e.id,
          name: e.name,
          size: e.size,
          sha256: e.sha256,
          relativePath: e.relativePath,
          title: e.title,
          kind: e.kind,
          system: e.system,
          target: e.target,
          phase: e.state === 'uploading' ? (e.target ? 'transferring' : 'creating') : e.state,
          sent: e.sent,
          idempotencyKey: e.idempotencyKey,
          baseRevision: e.baseRevision,
        };
      }),
    };
  }
  let checkpointSequence: Promise<void> = Promise.resolve();
  function checkpoint(): Promise<void> {
    const next = checkpointSequence.then(writeCheckpoint);
    checkpointSequence = next.catch(() => undefined);
    return next;
  }
  async function writeCheckpoint() {
    if (!current.remembering || !context.journal || !live()) return;
    try {
      if (current.entries.every((e) => e.state === 'succeeded')) {
        if (revision !== null) await context.journal.remove(revision);
        if (!live()) return;
        revision = null;
        publish({ recoverable: false });
      } else {
        const next = await context.journal.save(snapshot(), revision);
        if (!live()) return;
        revision = next;
        publish({ recoverable: true });
      }
    } catch (error) {
      throw new CheckpointFailure(`Upload progress could not be saved. ${explain(error)}`);
    }
  }
  async function run() {
    if (!live() || current.running || current.checking) return;
    publish({ running: true, stopping: false, status: null, failure: null });
    try {
      if (current.remembering) {
        for (const e of current.entries) {
          if (!live() || current.stopping) return;
          if (!e.sha256 && e.file) {
            publish({ checking: e.name });
            const hash = await fingerprintFile(e.file, () => live() && !current.stopping);
            if (!live()) return;
            e.sha256 = hash;
          }
        }
        publish({ checking: null });
        await checkpoint();
      }
      for (const e of current.entries) {
        if (!live() || current.stopping) break;
        if (e.state === 'succeeded' || e.state === 'reconciliation-required' || !e.file) continue;
        const file = e.file;
        e.state = 'uploading';
        e.failure = null;
        publish();
        let creationUncertain = false;
        try {
          // Persist intent before non-idempotent creation, and its receipt before starting bytes.
          await checkpoint();
          if (!live()) return;
          if (!e.target) {
            try {
              const created = await client.createItem({
                libraryId: context.libraryId,
                title: e.title.trim(),
                systemIdentifier: e.system,
              });
              if (!live()) return;
              e.target = created;
            } catch (error) {
              if (!(error instanceof ContentError) || error.status >= 500) creationUncertain = true;
              throw error;
            }
            await checkpoint();
          }
          if (!live()) return;
          if (!e.request) {
            let baseline = e.baseRevision ?? e.target.revision;
            if (e.baseRevision === null && touched.has(e.target.id)) {
              const manifest = await client.manifest(e.target.id);
              if (!live()) return;
              if (
                manifest.itemId !== e.target.id ||
                !Number.isSafeInteger(manifest.revision) ||
                manifest.revision < 1
              )
                throw new Error('Invalid item manifest');
              baseline = manifest.revision;
            }
            touched.add(e.target.id);
            e.baseRevision = baseline;
            e.request = {
              libraryId: context.libraryId,
              itemId: e.target.id,
              kind: e.kind,
              displayName: e.name,
              relativePath: e.relativePath,
              baseRevision: baseline,
              body: file,
              idempotencyKey: e.idempotencyKey,
              chunkBytes: 4 * 1024 * 1024,
              onProgress(sent) {
                if (!live()) throw new DOMException('The upload context changed.', 'AbortError');
                e.sent = sent;
                publish();
              },
            };
          }
          await checkpoint();
          if (!live()) return;
          await client.upload(e.request);
          if (!live()) return;
          e.state = 'succeeded';
          e.sent = e.size;
          publish();
          context.changed?.();
          await checkpoint();
        } catch (error) {
          if (!live()) return;
          if (error instanceof CheckpointFailure) {
            if (e.state !== 'succeeded') e.state = 'failed';
            publish({ failure: error.message });
            break;
          }
          e.state = creationUncertain ? 'reconciliation-required' : 'failed';
          e.failure = explain(error);
          const status = error instanceof ContentError ? error.status : null;
          publish({ status });
          if (status === 401 || status === 403) {
            publish({ stopping: true });
            context.authorizationRejected?.(status);
            break;
          }
          await checkpoint();
        }
      }
    } catch (error) {
      if (live() && !current.stopping) publish({ failure: explain(error) });
    } finally {
      publish({ running: false, checking: null });
    }
  }
  return {
    subscribe: store.subscribe,
    start(entries, remember = false) {
      if (
        !live() ||
        started ||
        !entries.length ||
        entries.some(
          (e) => e.errors.length || (e.target && e.target.libraryId !== context.libraryId),
        )
      )
        return Promise.resolve();
      if (remember && (!context.journal || entries.length > MAX_SAVED_UPLOADS)) {
        publish({ failure: 'Saved progress is unavailable for this queue.' });
        return Promise.resolve();
      }
      started = true;
      publish({
        remembering: remember,
        entries: entries.map((e) => ({
          ...e,
          name: e.file.name,
          size: e.file.size,
          sha256: null,
          state: 'waiting',
          sent: 0,
          failure: null,
          idempotencyKey: uploadIdentity(),
          request: null,
          baseRevision: null,
        })),
      });
      return run();
    },
    restore(record) {
      if (!live() || started || !context.journal) return;
      const saved = parseUploadCheckpoint(
        record.snapshot,
        context.libraryId,
        context.itemId ?? null,
      );
      if (!Number.isSafeInteger(record.revision) || record.revision < 1)
        throw new Error('Invalid saved upload revision.');
      revision = record.revision;
      started = true;
      saved.touched.forEach((id) => {
        touched.add(id);
      });
      publish({
        remembering: true,
        recoverable: true,
        entries: saved.entries.map((e) => ({
          ...e,
          file: null,
          errors: [],
          request: null,
          state:
            e.phase === 'creating' || e.phase === 'reconciliation-required'
              ? 'reconciliation-required'
              : e.phase === 'succeeded'
                ? 'succeeded'
                : 'waiting',
          failure: null,
        })),
      });
    },
    async attachFiles(files) {
      if (!live() || current.running || current.checking) return;
      publish({ failure: null, stopping: false });
      try {
        for (const file of files) {
          if (!live()) return;
          const path = file.webkitRelativePath;
          const candidates = current.entries.filter(
            (e) =>
              e.state !== 'succeeded' &&
              !e.file &&
              e.name === file.name &&
              e.size === file.size &&
              (!path || e.relativePath === path),
          );
          if (
            !candidates.length &&
            current.entries.some(
              (e) =>
                (e.state === 'succeeded' || e.file) &&
                e.name === file.name &&
                e.size === file.size &&
                (!path || e.relativePath === path),
            )
          )
            continue;
          if (candidates.length !== 1) {
            publish({
              failure:
                'Select the original files or folder. Duplicate names need the original folder paths.',
            });
            continue;
          }
          const e = candidates[0];
          if (!e) continue;
          publish({ checking: e.name });
          const hash = await fingerprintFile(file, () => live() && !current.stopping);
          if (!live()) return;
          if (hash !== e.sha256) {
            e.failure = 'File contents do not match the saved upload. Select the original file.';
            publish();
            continue;
          }
          e.file = file;
          e.failure = null;
          publish();
        }
      } catch (error) {
        if (live() && !current.stopping) publish({ failure: explain(error) });
      } finally {
        publish({ checking: null });
      }
    },
    async forgetProgress() {
      if (!live() || current.running || current.checking || !context.journal || revision === null)
        return;
      publish({ checking: 'saved progress' });
      try {
        await checkpointSequence;
        if (!live() || revision === null) return;
        await context.journal.remove(revision);
        if (live()) {
          revision = null;
          publish({ remembering: false, recoverable: false, failure: null });
        }
      } catch (error) {
        if (live() && !current.stopping) publish({ failure: explain(error) });
      } finally {
        publish({ checking: null });
      }
    },
    stopAfterCurrent() {
      if (current.running || current.checking) publish({ stopping: true });
    },
    retryUnfinished: run,
    async reconcile(id, item) {
      if (!live() || current.running || current.checking || item.libraryId !== context.libraryId)
        return;
      const e = current.entries.find((e) => e.id === id);
      if (e?.state !== 'reconciliation-required') return;
      e.target = item;
      e.baseRevision = null;
      e.request = null;
      e.state = 'waiting';
      e.failure = null;
      publish();
      try {
        await checkpoint();
      } catch (error) {
        if (live() && !current.stopping) publish({ failure: explain(error) });
      }
    },
    page(index) {
      publish({ page: Math.max(0, Math.min(index, current.pages - 1)) });
    },
    dispose() {
      disposed = true;
    },
  };
}
