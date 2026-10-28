import { sha256Text } from './file-fingerprint.js';
import {
  parseUploadCheckpoint,
  type UploadCheckpointRecord,
  type UploadJournal,
} from './upload-checkpoint.js';

const DATABASE = 'ecs-upload-progress-v1';
const STORE = 'queues';
const REVISIONS = 'revisions';
// Invalidate existing instances synchronously, before the asynchronous purge transaction opens.
const scopeEpochs = new Map<string, number>();
const scopeFor = (origin: string, credential: string) =>
  sha256Text(`${new URL(origin).origin}\0${credential}`);
const stale = () =>
  new Error('This upload session is no longer current. Reopen uploads to continue.');
const conflict = () =>
  new Error('Saved upload progress changed in another tab. Reopen uploads before continuing.');

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let rejected = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      const transaction = request.transaction;
      if (!transaction) throw new Error('Could not initialize saved upload progress.');
      for (const name of [STORE, REVISIONS]) {
        const store = db.objectStoreNames.contains(name)
          ? transaction.objectStore(name)
          : db.createObjectStore(name, { keyPath: 'key' });
        if (!store.indexNames.contains('scope')) store.createIndex('scope', 'scope');
      }
    };
    request.onblocked = () => {
      rejected = true;
      reject(
        new Error(
          'Saved upload progress storage is blocked by another tab. Close that tab and try again.',
        ),
      );
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Could not open saved upload progress.'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (rejected) db.close();
      else resolve(db);
    };
  });
}

/** Resolve only when the transaction commits, never merely when its request succeeds. */
async function transact<T>(
  mode: IDBTransactionMode,
  guard: () => void,
  work: (
    store: IDBObjectStore,
    done: (value: T) => void,
    fail: (error: unknown) => void,
    revisions: IDBObjectStore,
  ) => void,
): Promise<T> {
  guard();
  const db = await openDatabase();
  try {
    guard();
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction([STORE, REVISIONS], mode);
      let outcome: T;
      let reason: unknown;
      const fail = (error: unknown) => {
        reason = error;
        try {
          transaction.abort();
        } catch {
          reject(error);
        }
      };
      transaction.onabort = () =>
        reject(reason ?? transaction.error ?? new Error('Could not save upload progress.'));
      transaction.oncomplete = () => {
        try {
          guard();
          resolve(outcome);
        } catch (error) {
          reject(error);
        }
      };
      try {
        work(
          transaction.objectStore(STORE),
          (value) => {
            outcome = value;
          },
          fail,
          transaction.objectStore(REVISIONS),
        );
      } catch (error) {
        fail(error);
      }
    });
  } finally {
    db.close();
  }
}

function revisionOf(value: unknown, key: string, scope: string): number | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Saved upload progress is invalid. Discard it to start a new queue.');
  const row = value as Record<string, unknown>;
  if (
    row.key !== key ||
    row.scope !== scope ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 1
  )
    throw new Error('Saved upload progress is invalid. Discard it to start a new queue.');
  return row.revision as number;
}
function checkRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error('Saved upload progress revision is invalid. Reopen uploads before continuing.');
}

export function createUploadJournal(
  origin: string,
  credential: string,
  libraryId: string,
  itemId: string | null,
  isCurrent: () => boolean,
): UploadJournal | null {
  if (!credential || typeof indexedDB === 'undefined') return null;
  const scope = scopeFor(origin, credential);
  const key = JSON.stringify([scope, libraryId, itemId]);
  const epoch = scopeEpochs.get(scope) ?? 0;
  const guard = () => {
    if (!isCurrent() || epoch !== (scopeEpochs.get(scope) ?? 0)) throw stale();
  };
  return {
    read() {
      return transact<UploadCheckpointRecord | null>('readonly', guard, (store, done, fail) => {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            guard();
            const revision = revisionOf(request.result, key, scope);
            done(
              revision === null
                ? null
                : {
                    revision,
                    snapshot: parseUploadCheckpoint(request.result.snapshot, libraryId, itemId),
                  },
            );
          } catch (error) {
            fail(error);
          }
        };
      });
    },
    async save(snapshot, expectedRevision) {
      guard();
      if (expectedRevision !== null) checkRevision(expectedRevision);
      // Whitelist and copy metadata before an asynchronous operation can observe caller mutations.
      const parsed = parseUploadCheckpoint(snapshot, libraryId, itemId);
      return transact<number>('readwrite', guard, (store, done, fail, revisions) => {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            guard();
            if (revisionOf(request.result, key, scope) !== expectedRevision) throw conflict();
            const counter = revisions.get(key);
            counter.onsuccess = () => {
              try {
                guard();
                const previous = revisionOf(counter.result, key, scope) ?? 0;
                if (expectedRevision !== null && previous !== expectedRevision)
                  throw new Error(
                    'Saved upload progress revision is invalid. Discard it to start a new queue.',
                  );
                const revision = previous + 1;
                checkRevision(revision);
                revisions.put({ key, scope, revision });
                const put = store.put({ key, scope, revision, snapshot: parsed });
                put.onsuccess = () => {
                  try {
                    guard();
                    done(revision);
                  } catch (error) {
                    fail(error);
                  }
                };
              } catch (error) {
                fail(error);
              }
            };
          } catch (error) {
            fail(error);
          }
        };
      });
    },
    async remove(expectedRevision) {
      guard();
      checkRevision(expectedRevision);
      return transact<void>('readwrite', guard, (store, done, fail) => {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            guard();
            if (revisionOf(request.result, key, scope) !== expectedRevision) throw conflict();
            const remove = store.delete(key);
            remove.onsuccess = () => {
              try {
                guard();
                done(undefined);
              } catch (error) {
                fail(error);
              }
            };
          } catch (error) {
            fail(error);
          }
        };
      });
    },
    discard() {
      return transact<void>('readwrite', guard, (store, done, fail) => {
        guard();
        const request = store.delete(key);
        request.onsuccess = () => {
          try {
            guard();
            done(undefined);
          } catch (error) {
            fail(error);
          }
        };
      });
    },
  };
}

/** Remove only this credential's opaque scope; no credential is persisted or logged. */
export async function clearCredentialUploads(
  origin: string,
  credential: string | undefined,
): Promise<void> {
  if (!credential || typeof indexedDB === 'undefined') return;
  const scope = scopeFor(origin, credential);
  scopeEpochs.set(scope, (scopeEpochs.get(scope) ?? 0) + 1);
  await transact<void>(
    'readwrite',
    () => {},
    (store, done, _fail, revisions) => {
      let remaining = 2;
      for (const target of [store, revisions]) {
        const request = target.index('scope').openCursor(IDBKeyRange.only(scope));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else if (--remaining === 0) done(undefined);
        };
      }
    },
  );
}
