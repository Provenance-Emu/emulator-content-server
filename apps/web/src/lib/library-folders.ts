import {
  type ContentClient,
  ContentError,
  type ContentRoot,
  type ContentRootSummary,
  type LibraryScope,
} from '@ecs/client';
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
  existingRoot: ContentRoot | null;
  notice: string | null;
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
    existingRoot: null,
    notice: null,
  };
  const store = writable(current);
  const key = context.key;
  let disposed = false;
  let generation = 0;
  let scope = initialScope;
  const registrations = new Map<string, ContentRoot>();
  const unacknowledgedRoots = new Set<string>();
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
      ...(status
        ? { summaries: [], denied: true, scanFailures: {}, existingRoot: null, notice: null }
        : {}),
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
      if (live() && run === generation) {
        // A fresh local read can prove absence, but seeing the root here does not
        // order an older request in the independent parent cache bridge.
        const present = new Set(result.items.map((summary) => summary.root.id));
        for (const id of unacknowledgedRoots) if (!present.has(id)) unacknowledgedRoots.delete(id);
        update({ summaries: result.items, denied: false });
      }
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
    update({ busy: true, failure: null, notice: null });
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
      if (current.busy || current.denied) return;
      const received = new Set(summaries.map((summary) => summary.root.id));
      // A parent read with no matching ID may predate the registration. Seeing the ID
      // acknowledges the commit; until then preserve its row and retry action.
      for (const id of received) unacknowledgedRoots.delete(id);
      const pending = current.summaries.filter((summary) =>
        unacknowledgedRoots.has(summary.root.id),
      );
      update({ summaries: [...summaries, ...pending] });
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
          update({ existingRoot: null });
          try {
            root = await client.addRoot({
              path: selection.path.trim(),
              label: selection.suggestedName.trim() || folderName(selection.path),
              libraryId: scope.libraryId,
            });
          } catch (error) {
            if (!(error instanceof ContentError) || error.status !== 409) throw error;
            const known = await client.rootSummaries();
            if (!live()) return;
            const normalize = (path: string) => path.replace(/[\\/]+$/, '');
            let existing = known.items.find(
              (row) => normalize(row.root.path) === normalize(selection.path.trim()),
            )?.root;
            if (!existing) {
              const canonical = await client.folders(selection.path.trim());
              if (!live()) return;
              existing = known.items.find(
                (row) => normalize(row.root.path) === normalize(canonical.path),
              )?.root;
            }
            if (!existing) throw error;
            if (existing.libraryId === null) {
              update({
                existingRoot: existing,
                failure:
                  'This folder is already saved. Add the existing folder to this library below.',
              });
              return;
            }
            if (existing.libraryId !== scope.libraryId)
              throw new Error(
                'This folder is already linked to another library. Open that library to browse it.',
              );
            root = existing;
            update({
              notice: 'This folder is already in this library.',
            });
          }
          if (!live()) return;
          registrations.set(selection.path, root);
          unacknowledgedRoots.add(root.id);
          const registeredId = root.id;
          update({
            summaries: [
              ...current.summaries.filter((row) => row.root.id !== registeredId),
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
        unacknowledgedRoots.delete(id);
        for (const [path, root] of registrations) if (root.id === id) registrations.delete(path);
        await refresh();
        if (live() && !current.denied) await context.onchanged?.();
      });
    },
    async linkExisting() {
      const existing = current.existingRoot;
      if (!existing || !scope || !('libraryId' in scope)) return false;
      let linked = false;
      await mutate(async () => {
        await client.assignRoot(existing.id, {
          libraryId: scope && 'libraryId' in scope ? scope.libraryId : '',
        });
        if (!live()) return;
        linked = true;
        update({ existingRoot: null, notice: 'Existing folder linked to this library.' });
        await scan(existing.id);
        if (!live() || current.denied) return;
        await refresh();
        if (live() && !current.denied) await context.onchanged?.();
      });
      return linked;
    },
    async assign(id: string, libraryId: string) {
      if (
        !libraryId ||
        !current.summaries.some((s) => s.root.id === id && s.root.libraryId === null)
      )
        return false;
      let linked = false;
      await mutate(async () => {
        await client.assignRoot(id, { libraryId });
        if (!live()) return;
        linked = true;
        await scan(id);
        if (!live() || current.denied) return;
        update({ summaries: current.summaries.filter((s) => s.root.id !== id) });
        await refresh();
        if (live() && !current.denied) await context.onchanged?.();
      });
      return linked;
    },
    dispose() {
      disposed = true;
      generation++;
      registrations.clear();
      unacknowledgedRoots.clear();
      current = {
        ...current,
        summaries: [],
        scanFailures: {},
        busy: false,
        existingRoot: null,
        notice: null,
      };
      store.set(current);
    },
  };
}
