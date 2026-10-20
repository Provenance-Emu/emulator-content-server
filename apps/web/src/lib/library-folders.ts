import type { ContentClient, ContentRoot, ContentRootSummary, LibraryScope } from '@ecs/client';
import { writable } from 'svelte/store';
import {
  type FolderContext,
  type FolderSelection,
  folderName,
  validateFolderSelection,
} from './folder-selection.js';
import { explain, isForbidden, isUnauthorized } from './problems.js';

export interface LibraryFoldersState {
  summaries: ContentRootSummary[];
  busy: boolean;
  failure: string | null;
  scanFailures: Record<string, string>;
  denied: boolean;
}
export function createLibraryFolders(
  client: ContentClient,
  context: FolderContext,
  initialScope?: LibraryScope,
) {
  let current: LibraryFoldersState = {
    summaries: [],
    busy: false,
    failure: null,
    scanFailures: {},
    denied: false,
  };
  const store = writable(current);
  const key = context.key;
  let disposed = false;
  let generation = 0;
  let scope = initialScope;
  const registrations = new Map<string, ContentRoot>();
  const live = () => !disposed && context.key === key && (context.isCurrent?.() ?? true);
  function update(patch: Partial<LibraryFoldersState>) {
    if (live()) {
      current = { ...current, ...patch };
      store.set(current);
    }
  }
  function fail(error: unknown) {
    if (!live()) return;
    const status = isUnauthorized(error) ? 401 : isForbidden(error) ? 403 : null;
    update({
      failure: explain(error),
      ...(status ? { summaries: [], denied: true, scanFailures: {} } : {}),
    });
    if (status) {
      generation++;
      context.onrejected?.(status);
    }
  }
  async function refresh() {
    const run = ++generation;
    try {
      const result = await client.rootSummaries(scope);
      if (live() && run === generation) update({ summaries: result.items, denied: false });
    } catch (error) {
      if (run === generation) fail(error);
    }
  }
  async function scan(id: string) {
    try {
      await client.scanRoot(id);
      if (!live()) return false;
      const failures = { ...current.scanFailures };
      delete failures[id];
      update({ scanFailures: failures });
      return true;
    } catch (error) {
      if (live()) {
        update({ scanFailures: { ...current.scanFailures, [id]: explain(error) } });
        fail(error);
      }
      return false;
    }
  }
  async function mutate(action: () => Promise<void>) {
    if (!live() || current.busy || current.denied) return false;
    generation++;
    update({ busy: true, failure: null });
    try {
      await action();
      return live();
    } catch (error) {
      fail(error);
      return false;
    } finally {
      update({ busy: false });
    }
  }
  return {
    subscribe: store.subscribe,
    // Consume cached settings summaries without performing reads or scans on opening.
    receive(summaries: ContentRootSummary[]) {
      if (!current.busy && !current.denied) update({ summaries });
    },
    async load(nextScope?: LibraryScope) {
      if (!live() || current.busy) return;
      scope = nextScope;
      update({ failure: null });
      await refresh();
    },
    async add(selection: FolderSelection): Promise<boolean> {
      let registered = false;
      await mutate(async () => {
        if (!scope || !('libraryId' in scope))
          throw new Error('Choose a library before adding a folder.');
        if (!(await validateFolderSelection(selection, context)) || !live())
          throw new Error('This folder selection is no longer valid. Choose it again.');
        let root = registrations.get(selection.path);
        if (!root) {
          root = await client.addRoot({
            path: selection.path.trim(),
            label: selection.suggestedName.trim() || folderName(selection.path),
            libraryId: scope.libraryId,
          });
          if (!live()) return;
          registrations.set(selection.path, root);
          update({
            summaries: [
              ...current.summaries,
              {
                root,
                indexedFileCount: 0,
                scanState: 'never',
                lastScanAt: null,
                lastCheckAt: null,
                online: null,
                medium: null,
              },
            ],
          });
        }
        registered = true;
        await scan(root.id);
        if (!live() || current.denied) return;
        await refresh();
        if (live() && !current.denied) await context.onchanged?.();
      });
      return registered;
    },
    retryScan(id: string) {
      return mutate(async () => {
        if (!current.summaries.some((s) => s.root.id === id)) return;
        await scan(id);
        if (!live() || current.denied) return;
        await refresh();
        if (live() && !current.denied) await context.onchanged?.();
      });
    },
    scanLibrary() {
      return mutate(async () => {
        if (!scope || !('libraryId' in scope)) return;
        const libraryId = scope.libraryId;
        for (const summary of current.summaries.filter((s) => s.root.libraryId === libraryId)) {
          if (!live() || current.denied) return;
          await scan(summary.root.id);
        }
        if (!live() || current.denied) return;
        await refresh();
        if (live() && !current.denied) await context.onchanged?.();
      });
    },
    remove(id: string) {
      return mutate(async () => {
        if (!current.summaries.some((s) => s.root.id === id)) return;
        await client.removeRoot(id);
        if (!live()) return;
        update({ summaries: current.summaries.filter((s) => s.root.id !== id) });
        for (const [path, root] of registrations) if (root.id === id) registrations.delete(path);
        await refresh();
        if (live() && !current.denied) await context.onchanged?.();
      });
    },
    assign(id: string, libraryId: string) {
      return mutate(async () => {
        if (
          !libraryId ||
          !current.summaries.some((s) => s.root.id === id && s.root.libraryId === null)
        )
          return;
        await client.assignRoot(id, { libraryId });
        if (!live()) return;
        update({ summaries: current.summaries.filter((s) => s.root.id !== id) });
        await refresh();
        if (live() && !current.denied) await context.onchanged?.();
      });
    },
    dispose() {
      disposed = true;
      generation++;
      registrations.clear();
      current = { ...current, summaries: [], scanFailures: {}, busy: false };
      store.set(current);
    },
  };
}
