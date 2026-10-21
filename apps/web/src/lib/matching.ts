import {
  type ContentClient,
  ContentError,
  type MatchingOptions,
  type SourceMatches,
  type SourceMatchSelections,
} from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { explain } from './problems.js';
export interface MatchingState {
  result: SourceMatches | null;
  loading: boolean;
  failure: string | null;
  artwork: Record<string, string>;
  previewing: string | null;
  saved: SourceMatchSelections | null;
  savedArtwork: string | null;
  savedLoading: boolean;
  savedLoadFailed: boolean;
  saving: string | null;
}
export interface MatchingController extends Readable<MatchingState> {
  load(): Promise<void>;
  find(options: MatchingOptions): Promise<void>;
  preview(id: string): Promise<void>;
  save(id: string): Promise<boolean>;
  remove(kind: string): Promise<boolean>;
  clear(): void;
  invalidate(): void;
  dispose(): void;
}
export function createMatching(client: ContentClient, sourceId: string): MatchingController {
  let current: MatchingState = {
    result: null,
    loading: false,
    failure: null,
    artwork: {},
    previewing: null,
    saved: null,
    savedArtwork: null,
    savedLoading: false,
    savedLoadFailed: false,
    saving: null,
  };
  const store = writable(current);
  let disposed = false;
  let denied = false;
  let epoch = 0;
  let request: AbortController | null = null;
  const lifetime = new AbortController();
  const live = (run: number) => !disposed && !denied && epoch === run;
  function update(patch: Partial<MatchingState>) {
    current = { ...current, ...patch };
    store.set(current);
  }
  function clearResults() {
    for (const url of Object.values(current.artwork)) URL.revokeObjectURL(url);
    update({ result: null, artwork: {}, previewing: null, failure: null });
  }
  function clearSaved() {
    if (current.savedArtwork) URL.revokeObjectURL(current.savedArtwork);
    update({ saved: null, savedArtwork: null });
  }
  function invalidate() {
    if (disposed || denied) return;
    denied = true;
    epoch++;
    request?.abort();
    lifetime.abort();
    clearResults();
    clearSaved();
    update({
      loading: false,
      savedLoading: false,
      savedLoadFailed: false,
      saving: null,
      previewing: null,
    });
  }
  function failure(error: unknown) {
    if (
      error instanceof ContentError &&
      ([401, 403].includes(error.status) ||
        (error.status === 404 && !error.problem?.type.endsWith('artwork-unavailable')))
    ) {
      invalidate();
    }
    update({ failure: explain(error) });
  }
  async function showSaved(saved: SourceMatchSelections, run: number) {
    if (!live(run)) return;
    const oldId = current.saved?.matches.find((m) => m.kind === 'artwork')?.id;
    update({ saved });
    const art = saved.matches.find((m) => m.kind === 'artwork' && m.contentAvailable);
    if (!art) {
      if (current.savedArtwork) URL.revokeObjectURL(current.savedArtwork);
      update({ savedArtwork: null });
      return;
    }
    if (oldId === art.id && current.savedArtwork) return;
    if (current.savedArtwork) URL.revokeObjectURL(current.savedArtwork);
    update({ savedArtwork: null });
    try {
      const blob = await client.selectedMatchContent(sourceId, 'artwork', lifetime.signal);
      if (live(run)) update({ savedArtwork: URL.createObjectURL(blob) });
    } catch (error) {
      if (live(run)) failure(error);
    }
  }
  async function mutate(id: string, remove: boolean): Promise<boolean> {
    if (
      disposed ||
      denied ||
      current.loading ||
      current.savedLoading ||
      current.saving ||
      !current.saved
    )
      return false;
    const result = current.result;
    if (
      remove
        ? !current.saved.matches.some((m) => m.kind === id)
        : !result?.candidates.some((m) => m.id === id)
    )
      return false;
    const run = epoch;
    const revision = current.saved.revision;
    update({ saving: id, failure: null });
    try {
      const saved = remove
        ? await client.removeSourceMatch(sourceId, id, revision, lifetime.signal)
        : await client.saveSourceMatch(
            sourceId,
            result?.requestId ?? '',
            id,
            revision,
            lifetime.signal,
          );
      await showSaved(saved, run);
      return live(run);
    } catch (error) {
      if (live(run)) {
        if (error instanceof ContentError && error.status === 409) {
          try {
            await showSaved(await client.sourceSelections(sourceId, lifetime.signal), run);
          } catch (refreshError) {
            failure(refreshError);
          }
        }
        failure(error);
      }
      return false;
    } finally {
      if (live(run)) update({ saving: null });
    }
  }
  return {
    subscribe: store.subscribe,
    async load() {
      if (disposed || denied || current.savedLoading || current.saving || current.loading) return;
      const run = epoch;
      update({ savedLoading: true, savedLoadFailed: false, failure: null });
      try {
        await showSaved(await client.sourceSelections(sourceId, lifetime.signal), run);
      } catch (error) {
        if (live(run)) {
          failure(error);
          if (live(run)) update({ savedLoadFailed: true });
        }
      } finally {
        if (live(run)) update({ savedLoading: false });
      }
    },
    async find(options) {
      if (disposed || denied || current.loading || current.savedLoading || current.saving) return;
      const run = ++epoch;
      request?.abort();
      request = new AbortController();
      clearResults();
      update({ loading: true });
      try {
        const result = await client.sourceMatches(
          sourceId,
          options,
          AbortSignal.any([request.signal, lifetime.signal]),
        );
        if (live(run)) update({ result });
      } catch (error) {
        if (live(run)) failure(error);
      } finally {
        if (live(run)) update({ loading: false });
      }
    },
    async preview(id) {
      if (disposed || denied || current.loading || current.previewing || current.artwork[id])
        return;
      const result = current.result;
      if (!result?.candidates.some((c) => c.id === id && c.kind === 'artwork')) return;
      const run = epoch;
      update({ previewing: id, failure: null });
      try {
        const blob = await client.matchingArtwork(sourceId, result.requestId, id, request?.signal);
        if (live(run)) update({ artwork: { ...current.artwork, [id]: URL.createObjectURL(blob) } });
      } catch (error) {
        if (live(run)) failure(error);
      } finally {
        if (live(run)) update({ previewing: null });
      }
    },
    save(id) {
      return mutate(id, false);
    },
    remove(kind) {
      return mutate(kind, true);
    },
    clear() {
      if (disposed || denied || current.saving || current.savedLoading) return;
      epoch++;
      request?.abort();
      clearResults();
      update({ loading: false });
    },
    invalidate,
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch++;
      request?.abort();
      lifetime.abort();
      clearResults();
      clearSaved();
      update({ loading: false, savedLoading: false, savedLoadFailed: false, saving: null });
    },
  };
}
