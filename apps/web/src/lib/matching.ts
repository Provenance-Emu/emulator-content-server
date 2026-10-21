import {
  type ContentClient,
  ContentError,
  type MatchingOptions,
  type SourceMatches,
} from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { explain } from './problems.js';
export interface MatchingState {
  result: SourceMatches | null;
  loading: boolean;
  failure: string | null;
  artwork: Record<string, string>;
  previewing: string | null;
}
export interface MatchingController extends Readable<MatchingState> {
  find(options: MatchingOptions): Promise<void>;
  preview(id: string): Promise<void>;
  clear(): void;
  dispose(): void;
}
export function createMatching(client: ContentClient, sourceId: string): MatchingController {
  let current: MatchingState = {
    result: null,
    loading: false,
    failure: null,
    artwork: {},
    previewing: null,
  };
  const store = writable(current);
  let disposed = false;
  let epoch = 0;
  let request: AbortController | null = null;
  const live = (run: number) => !disposed && epoch === run;
  function update(patch: Partial<MatchingState>) {
    current = { ...current, ...patch };
    store.set(current);
  }
  function clear() {
    for (const url of Object.values(current.artwork)) URL.revokeObjectURL(url);
    update({ result: null, artwork: {}, previewing: null, failure: null });
  }
  return {
    subscribe: store.subscribe,
    async find(options) {
      if (disposed || current.loading) return;
      const run = ++epoch;
      request?.abort();
      request = new AbortController();
      clear();
      update({ loading: true });
      try {
        const result = await client.sourceMatches(sourceId, options, request.signal);
        if (live(run)) update({ result });
      } catch (error) {
        if (live(run)) {
          if (error instanceof ContentError && [401, 403, 404].includes(error.status)) clear();
          update({ failure: explain(error) });
        }
      } finally {
        if (live(run)) update({ loading: false });
      }
    },
    async preview(id) {
      if (disposed || current.loading || current.previewing || current.artwork[id]) return;
      const result = current.result;
      if (!result?.candidates.some((c) => c.id === id && c.kind === 'artwork')) return;
      const run = epoch;
      update({ previewing: id, failure: null });
      try {
        const blob = await client.matchingArtwork(sourceId, result.requestId, id, request?.signal);
        if (live(run)) update({ artwork: { ...current.artwork, [id]: URL.createObjectURL(blob) } });
      } catch (error) {
        if (live(run)) {
          if (error instanceof ContentError && [401, 403, 404].includes(error.status)) clear();
          update({ failure: explain(error) });
        }
      } finally {
        if (live(run)) update({ previewing: null });
      }
    },
    clear() {
      if (disposed) return;
      epoch++;
      request?.abort();
      clear();
      update({ loading: false });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch++;
      request?.abort();
      clear();
      update({ loading: false });
    },
  };
}
