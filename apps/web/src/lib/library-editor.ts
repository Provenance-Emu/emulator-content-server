import { type ContentClient, ContentError, type Library } from '@ecs/client';
import { writable } from 'svelte/store';
import {
  type FolderContext,
  type FolderSelection,
  folderName,
  validateFolderSelection,
} from './folder-selection.js';
import { explain, isForbidden, isUnauthorized } from './problems.js';

export interface StagedFolder {
  selection: FolderSelection;
  rootId: string | null;
  scanned: boolean;
  failure: string | null;
}
export interface LibraryEditorState {
  name: string;
  libraryId: string | null;
  folders: StagedFolder[];
  busy: boolean;
  failure: string | null;
  reconciliationRequired: boolean;
  complete: boolean;
}
export function createLibraryEditor(
  client: ContentClient,
  context: FolderContext,
  library?: Library,
) {
  let current: LibraryEditorState = {
    name: library?.name ?? '',
    libraryId: library?.id ?? null,
    folders: [],
    busy: false,
    failure: null,
    reconciliationRequired: false,
    complete: false,
  };
  const store = writable(current);
  const key = context.key;
  let disposed = false;
  let edited = false;
  let renamed = false;
  let denied = false;
  const live = () => !disposed && context.key === key && (context.isCurrent?.() ?? true);
  function update(patch: Partial<LibraryEditorState>) {
    if (live()) {
      current = { ...current, ...patch };
      store.set(current);
    }
  }
  function fail(error: unknown) {
    if (!live()) return;
    update({ failure: explain(error) });
    if (isUnauthorized(error) || isForbidden(error)) {
      denied = true;
      update({ folders: [], name: '', libraryId: null });
      context.onrejected?.(isUnauthorized(error) ? 401 : 403);
    }
  }
  async function submit(): Promise<boolean> {
    if (!live() || denied || current.busy || current.complete || current.reconciliationRequired)
      return false;
    if (!current.name.trim()) {
      update({ failure: 'Enter a library name.' });
      return false;
    }
    update({ busy: true, failure: null });
    try {
      for (const folder of current.folders) {
        if (folder.rootId) continue;
        if (!(await validateFolderSelection(folder.selection, context)) || !live())
          throw new Error('This folder selection is no longer valid. Choose it again.');
      }
      if (!current.libraryId) {
        try {
          const created = await client.createLibrary({ name: current.name.trim() });
          if (!live()) return false;
          if (!created?.id) throw new Error('The server did not return the created library.');
          update({ libraryId: created.id });
        } catch (error) {
          if (
            live() &&
            !(error instanceof ContentError && error.status >= 400 && error.status < 500)
          )
            update({ reconciliationRequired: true });
          throw error;
        }
      } else if (library && !renamed) {
        await client.renameLibrary(library.id, { name: current.name.trim() }, library.revision);
        if (!live()) return false;
        renamed = true;
      }
      for (const folder of current.folders) {
        if (folder.scanned) continue;
        try {
          if (!folder.rootId) {
            if (!(await validateFolderSelection(folder.selection, context)) || !live())
              return false;
            const root = await client.addRoot({
              path: folder.selection.path.trim(),
              label: folder.selection.suggestedName.trim() || folderName(folder.selection.path),
              libraryId: current.libraryId,
            });
            if (!live()) return false;
            folder.rootId = root.id;
            update({ folders: [...current.folders] });
          }
          if (!live()) return false;
          await client.scanRoot(folder.rootId);
          if (!live()) return false;
          folder.scanned = true;
          folder.failure = null;
          update({ folders: [...current.folders] });
        } catch (error) {
          if (live()) {
            folder.failure = explain(error);
            update({ folders: [...current.folders] });
          }
          throw error;
        }
      }
      if (!live()) return false;
      await context.onchanged?.();
      if (!live()) return false;
      update({ complete: true });
      return true;
    } catch (error) {
      fail(error);
      return false;
    } finally {
      update({ busy: false });
    }
  }
  return {
    subscribe: store.subscribe,
    setName(name: string) {
      if (!current.busy && (!current.libraryId || (library && !renamed))) {
        edited = true;
        update({ name });
      }
    },
    async stageFolder(selection: FolderSelection) {
      if (
        !live() ||
        denied ||
        current.busy ||
        current.libraryId ||
        !(await validateFolderSelection(selection, context)) ||
        !live() ||
        current.busy
      )
        return false;
      if (current.folders.some((f) => f.selection.path === selection.path)) return false;
      update({
        folders: [
          ...current.folders,
          { selection: { ...selection }, rootId: null, scanned: false, failure: null },
        ],
        ...(!edited && current.folders.length === 0 ? { name: folderName(selection.path) } : {}),
      });
      return true;
    },
    removeStagedFolder(index: number) {
      if (!current.busy && !current.libraryId)
        update({ folders: current.folders.filter((_, i) => i !== index) });
    },
    submit,
    retryRemaining: submit,
    async reconcileCreatedLibrary(id: string) {
      if (!live() || denied || current.busy || !current.reconciliationRequired || !id) return false;
      update({ busy: true, failure: null });
      try {
        const listing = await client.browseLibraries();
        if (!live()) return false;
        if (!listing.items.some((item) => item.id === id))
          throw new Error('Choose an accessible existing library.');
        update({ libraryId: id, reconciliationRequired: false });
        return true;
      } catch (error) {
        fail(error);
        return false;
      } finally {
        update({ busy: false });
      }
    },
    dispose() {
      disposed = true;
      current = { ...current, folders: [], name: '', libraryId: null, busy: false };
      store.set(current);
    },
  };
}
