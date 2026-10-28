import {
  type ContentClient,
  ContentError,
  type MatchingOptions,
  type SourceMatches,
  type SourceMatchSelections,
} from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { matchSlot, roleOf } from './matching-slots.js';
import { explain } from './problems.js';
export interface MatchingState {
  result: SourceMatches | null;
  suggestionsStale: boolean;
  loading: boolean;
  failure: string | null;
  artwork: Record<string, string>;
  previewing: string | null;
  saved: SourceMatchSelections | null;
  savedArtwork: string | null;
  savedArtworkByRole: Record<string, string>;
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
  previewSaved(role: string): Promise<void>;
  clear(): void;
  invalidate(): void;
  dispose(): void;
}
export function createMatching(client: ContentClient, sourceId: string): MatchingController {
  let current: MatchingState = {
    result: null,
    suggestionsStale: false,
    loading: false,
    failure: null,
    artwork: {},
    previewing: null,
    saved: null,
    savedArtwork: null,
    savedArtworkByRole: {},
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
  let lastOptions: MatchingOptions = {};
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
    for (const url of new Set([current.savedArtwork, ...Object.values(current.savedArtworkByRole)]))
      if (url) URL.revokeObjectURL(url);
    update({ saved: null, savedArtwork: null, savedArtworkByRole: {} });
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
    const oldId = current.saved?.matches.find(
      (m) => m.kind === 'artwork' && roleOf(m) === 'front',
    )?.id;
    const previews = { ...current.savedArtworkByRole };
    for (const role of Object.keys(previews)) {
      const before = current.saved?.matches.find(
        (m) => m.kind === 'artwork' && roleOf(m) === role,
      )?.id;
      const next = saved.matches.find((m) => m.kind === 'artwork' && roleOf(m) === role)?.id;
      if (before !== next) {
        const url = previews[role];
        if (url) URL.revokeObjectURL(url);
        delete previews[role];
      }
    }
    update({ saved, savedArtworkByRole: previews });
    const art = saved.matches.find(
      (m) => m.kind === 'artwork' && roleOf(m) === 'front' && m.contentAvailable,
    );
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
  async function afterOrganization(saved: SourceMatchSelections, run: number, uncertain = false) {
    if (!live(run)) return;
    const outcome =
      'automaticOrganization' in saved
        ? (saved.automaticOrganization as { status: string; warning?: string })
        : undefined;
    if (uncertain || outcome?.status === 'moved') {
      update({ suggestionsStale: true });
      try {
        const result = await client.sourceMatches(sourceId, lastOptions, lifetime.signal);
        if (!live(run)) return;
        clearResults();
        update({ result, suggestionsStale: false });
      } catch (error) {
        if (live(run)) {
          failure(error);
          if (live(run))
            update({
              failure: `Match saved. Suggestions could not refresh after organization: ${explain(error)}. Find matches again.`,
            });
        }
      }
    }
    if (live(run) && outcome?.warning)
      update({ failure: `Match saved. Automatic organization: ${outcome.warning}` });
  }
  async function mutate(id: string, remove: boolean): Promise<boolean> {
    if (
      disposed ||
      denied ||
      current.loading ||
      current.savedLoading ||
      current.savedLoadFailed ||
      current.saving ||
      !current.saved ||
      (!remove && current.suggestionsStale)
    )
      return false;
    const result = current.result;
    if (
      remove
        ? !current.saved.matches.some(
            (m) => matchSlot(m) === id || (id === 'artwork' && matchSlot(m) === 'artwork:front'),
          )
        : !result?.candidates.some((m) => m.id === id)
    )
      return false;
    const run = epoch;
    const revision = current.saved.revision;
    update({ saving: id, failure: null });
    try {
      const saved = remove
        ? await client.removeSourceMatch(
            sourceId,
            id.split(':')[0] ?? id,
            revision,
            lifetime.signal,
            id.startsWith('artwork:') ? id.slice(8) : undefined,
          )
        : await client.saveSourceMatch(
            sourceId,
            result?.requestId ?? '',
            id,
            revision,
            lifetime.signal,
          );
      await showSaved(saved, run);
      if (!remove) await afterOrganization(saved, run);
      return live(run);
    } catch (error) {
      if (!live(run)) return false;
      // A disconnected/failed response may follow a committed write. Read current
      // state before permitting another write; a conflict never retries itself.
      const uncertain = !(error instanceof ContentError) || error.status >= 500;
      if (uncertain || (error instanceof ContentError && error.status === 409)) {
        try {
          const saved = await client.sourceSelections(sourceId, lifetime.signal);
          if (!live(run)) return false;
          update({ savedLoadFailed: false });
          await showSaved(saved, run);
          if (!live(run)) return false;
          if (
            uncertain &&
            (remove
              ? !saved.matches.some(
                  (match) =>
                    matchSlot(match) === id ||
                    (id === 'artwork' && matchSlot(match) === 'artwork:front'),
                )
              : saved.matches.some((match) => match.id === id))
          ) {
            if (!remove) await afterOrganization(saved, run, true);
            return live(run);
          }
        } catch (refreshError) {
          if (live(run)) {
            failure(refreshError);
            if (live(run)) update({ savedLoadFailed: true });
          }
          return false;
        }
      }
      if (live(run)) failure(error);
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
      lastOptions = {
        ...options,
        ...(options.providerIds ? { providerIds: [...options.providerIds] } : {}),
      };
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
        if (live(run)) update({ result, suggestionsStale: false });
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
    async previewSaved(role) {
      if (disposed || denied || current.savedArtworkByRole[role]) return;
      const selected = current.saved?.matches.find(
        (match) =>
          match.kind === 'artwork' &&
          roleOf(match) === role &&
          match.contentAvailable &&
          match.contentType?.startsWith('image/'),
      );
      if (!selected) return;
      const run = epoch;
      try {
        const blob = await client.selectedMatchContent(sourceId, 'artwork', lifetime.signal, role);
        if (live(run) && current.saved?.matches.some((match) => match.id === selected.id))
          update({
            savedArtworkByRole: {
              ...current.savedArtworkByRole,
              [role]: URL.createObjectURL(blob),
            },
          });
      } catch (error) {
        if (live(run)) failure(error);
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
