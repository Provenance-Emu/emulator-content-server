import type { ContentClient, StorageLocationDraft, StorageLocationList } from '@ecs/client';
import { writable } from 'svelte/store';
import { explain, isForbidden, isUnauthorized } from './problems.js';

export type StorageClient = Pick<
  ContentClient,
  'storageLocations' | 'addStorageLocation' | 'setStorageWriteTarget' | 'removeStorageLocation'
>;
interface StorageState {
  listing: StorageLocationList | null;
  busy: boolean;
  failure: string | null;
  denied: boolean;
}

/** All paths and presence come from the owner-only API on the server. */
export function createStorageLocations(client: StorageClient, changed: () => void = () => {}) {
  let current: StorageState = { listing: null, busy: false, failure: null, denied: false };
  const store = writable(current);
  function update(patch: Partial<StorageState>) {
    current = { ...current, ...patch };
    store.set(current);
  }
  async function run(action?: () => Promise<unknown>): Promise<boolean> {
    if (current.busy || (action && (!current.listing || current.denied))) return false;
    update({ busy: true, failure: null });
    let committed = false;
    try {
      if (action) {
        await action();
        committed = true;
        changed();
      }
      update({ listing: await client.storageLocations(), denied: false });
      return true;
    } catch (error) {
      const denied = isForbidden(error) || isUnauthorized(error);
      update({
        failure: committed
          ? `The change was saved, but locations could not be refreshed. ${explain(error)}`
          : explain(error),
        ...(denied || committed ? { listing: null, denied } : {}),
      });
      return committed;
    } finally {
      update({ busy: false });
    }
  }
  return {
    subscribe: store.subscribe,
    load: () => run(),
    add: (draft: StorageLocationDraft) => run(() => client.addStorageLocation(draft)),
    select: (id: string | null) => run(() => client.setStorageWriteTarget(id)),
    remove: (id: string) => run(() => client.removeStorageLocation(id)),
  };
}
