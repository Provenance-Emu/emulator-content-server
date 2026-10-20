import type {
  ContentClient,
  StorageLocation,
  StorageLocationDraft,
  StorageLocationList,
} from '@ecs/client';
import { writable } from 'svelte/store';
import {
  type FolderContext,
  type FolderSelection,
  folderName,
  validateFolderSelection,
} from './folder-selection.js';
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
  pendingDestination: StorageLocation | null;
}

/** All paths and presence come from the owner-only API on the server. */
export function createStorageLocations(
  client: StorageClient,
  changed: () => void = () => {},
  context?: FolderContext,
) {
  let current: StorageState = {
    listing: null,
    busy: false,
    failure: null,
    denied: false,
    pendingDestination: null,
  };
  const store = writable(current);
  const key = context?.key;
  let disposed = false;
  let pendingPath: string | null = null;
  const live = () =>
    !disposed && (!context || (context.key === key && (context.isCurrent?.() ?? true)));
  function update(patch: Partial<StorageState>) {
    if (!live()) return;
    current = { ...current, ...patch };
    store.set(current);
  }
  function failure(error: unknown, committed = false) {
    if (!live()) return;
    const denied = isForbidden(error) || isUnauthorized(error);
    update({
      failure: committed
        ? `The change was saved, but locations could not be refreshed. ${explain(error)}`
        : explain(error),
      ...(denied || committed ? { listing: null, denied } : {}),
      ...(denied ? { pendingDestination: null } : {}),
    });
    if (denied) context?.onrejected?.(isUnauthorized(error) ? 401 : 403);
  }
  async function run(action?: () => Promise<unknown>): Promise<boolean> {
    if (!live() || current.busy || (action && (!current.listing || current.denied))) return false;
    update({ busy: true, failure: null });
    let committed = false;
    try {
      if (action) {
        await action();
        if (!live()) return false;
        committed = true;
        changed();
      }
      const listing = await client.storageLocations();
      if (!live()) return false;
      update({ listing, denied: false });
      return true;
    } catch (error) {
      failure(error, committed);
      return committed;
    } finally {
      update({ busy: false });
    }
  }
  return {
    subscribe: store.subscribe,
    load: () => run(),
    add: (draft: StorageLocationDraft) => run(() => client.addStorageLocation(draft)),
    select: (id: string | null) =>
      run(async () => {
        await client.setStorageWriteTarget(id);
        if (live() && current.pendingDestination?.id === id) {
          update({ pendingDestination: null });
          pendingPath = null;
        }
      }),
    remove: (id: string) => run(() => client.removeStorageLocation(id)),
    async addDestination(selection: FolderSelection, makeWriteTarget: boolean): Promise<boolean> {
      if (
        !live() ||
        !context ||
        current.busy ||
        current.denied ||
        (!current.listing && !current.pendingDestination)
      )
        return false;
      update({ busy: true, failure: null });
      let selected = false;
      try {
        if (!(await validateFolderSelection(selection, context)) || !live())
          throw new Error('This folder selection is no longer valid. Choose it again.');
        if (current.pendingDestination && pendingPath !== selection.path)
          throw new Error('Finish selecting the saved destination before adding another.');
        let destination = current.pendingDestination;
        if (!destination) {
          destination = await client.addStorageLocation({
            path: selection.path.trim(),
            label: selection.suggestedName.trim() || folderName(selection.path),
          });
          if (!live()) return false;
          pendingPath = selection.path;
          update({ pendingDestination: destination });
          changed();
        }
        if (makeWriteTarget) {
          await client.setStorageWriteTarget(destination.id);
          if (!live()) return false;
          changed();
        }
        selected = true;
        update({ pendingDestination: null });
        pendingPath = null;
        try {
          const listing = await client.storageLocations();
          if (!live()) return false;
          update({ listing, denied: false });
        } catch (error) {
          failure(error, true);
        }
        return true;
      } catch (error) {
        failure(error);
        if (live() && current.pendingDestination && !current.denied)
          update({
            failure: `Destination saved. ${explain(error)} Retry to finish choosing where new uploads are saved.`,
          });
        return selected;
      } finally {
        update({ busy: false });
      }
    },
    dispose() {
      disposed = true;
      current = { ...current, listing: null, pendingDestination: null, busy: false };
      store.set(current);
    },
  };
}
