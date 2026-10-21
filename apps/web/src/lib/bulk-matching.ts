import {
  type ContentClient,
  ContentError,
  type LibraryBrowseEntry,
  type LibraryScope,
  type MatchingOptions,
  type SourceFile,
  type SourceMatches,
  type SourceMatchSelections,
} from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { explain } from './problems.js';

export type BulkStatus =
  | 'pending'
  | 'working'
  | 'saved'
  | 'review'
  | 'unmatched'
  | 'failed'
  | 'skipped'
  | 'reviewed';
export interface BulkMatchRow {
  entry: LibraryBrowseEntry;
  status: BulkStatus;
  saved: number;
  suggestions: number;
  reason: string;
  retryable: boolean;
}
export interface BulkMatchingState {
  phase: 'idle' | 'discovering' | 'running' | 'paused' | 'complete';
  rows: BulkMatchRow[];
  options: MatchingOptions;
  failure: string | null;
}
export interface BulkMatchingController extends Readable<BulkMatchingState> {
  start(scope: LibraryScope, options: MatchingOptions): Promise<void>;
  resume(): Promise<void>;
  retryFailures(): Promise<void>;
  reviewed(id: string): void;
  pause(): void;
  reset(): void;
  dispose(): void;
}

export function canChecksum(source: SourceFile): boolean {
  return (
    source.availability === 'local' &&
    source.size <= 64 * 1024 * 1024 &&
    (source.groupFileCount ?? 1) <= 1 &&
    !/\.(zip|7z|chd|cdi|iso|cue|m3u|gdi|ccd)$/i.test(source.name)
  );
}

/** Trust provider checksum evidence only when this lookup actually hashed the ROM.
 * Never replace a saved category, pick between exact alternatives, or hide partial failures.
 */
function plan(result: SourceMatches, saved: SourceMatchSelections, checksum: boolean) {
  const remaining = result.candidates.filter((c) => !saved.matches.some((m) => m.kind === c.kind));
  const systems = new Set(
    [...saved.matches, ...remaining.filter((c) => c.confidence === 'checksum')]
      .map((c) => c.metadata.systemId)
      .filter(Boolean),
  );
  const auto =
    checksum && !result.problems.length && systems.size <= 1
      ? remaining.filter(
          (c) =>
            c.confidence === 'checksum' &&
            remaining.filter((other) => other.kind === c.kind && other.confidence === 'checksum')
              .length === 1,
        )
      : [];
  return { auto, remaining };
}

/** One cancellable browser run. Provider execution, source validation and writes stay on the server. */
export function createBulkMatching(
  client: ContentClient,
  hooks: { changed?: () => void; authorizationRejected?: (status: 401 | 403) => void } = {},
): BulkMatchingController {
  const initial = (): BulkMatchingState => ({
    phase: 'idle',
    rows: [],
    options: {},
    failure: null,
  });
  let current = initial();
  const store = writable(current);
  let disposed = false;
  let denied = false;
  let epoch = 0;
  let request: AbortController | null = null;
  let scope: LibraryScope | null = null;
  let discovered = false;
  const live = (run: number) => !disposed && !denied && run === epoch;
  const busy = () => current.phase === 'discovering' || current.phase === 'running';
  function update(patch: Partial<BulkMatchingState>) {
    current = { ...current, ...patch };
    store.set(current);
  }
  function row(id: string, patch: Partial<BulkMatchRow>) {
    update({
      rows: current.rows.map((r) =>
        r.entry.id === id && r.entry.entityType === 'source' ? { ...r, ...patch } : r,
      ),
    });
  }
  function reject(error: unknown) {
    if (!(error instanceof ContentError) || ![401, 403].includes(error.status)) return false;
    denied = true;
    epoch++;
    request?.abort();
    update({ ...initial(), failure: explain(error) });
    hooks.authorizationRejected?.(error.status as 401 | 403);
    return true;
  }
  async function discover(run: number, signal: AbortSignal) {
    if (!scope) return;
    // Collect first: accepted titles can reorder later browse pages.
    const rows: BulkMatchRow[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.browse(
        { ...scope, category: 'games', limit: 100, ...(cursor ? { cursor } : {}) },
        signal,
      );
      if (!live(run)) return;
      for (const entry of page.items) {
        const key = `${entry.entityType}:${entry.id}`;
        if (ids.has(key)) continue;
        ids.add(key);
        if (rows.length >= 50000)
          throw new Error(
            'This run is limited to 50,000 games. Split larger collections into libraries.',
          );
        const reason = !entry.source
          ? 'Matching currently supports games linked from server folders.'
          : entry.source.availability !== 'local'
            ? 'Server folder is offline or unavailable.'
            : '';
        rows.push({
          entry,
          status: reason ? 'skipped' : 'pending',
          saved: 0,
          suggestions: 0,
          reason,
          retryable: false,
        });
      }
      update({ rows: [...rows] });
      if (page.nextCursor && cursors.has(page.nextCursor))
        throw new Error(
          'Library pagination repeated. Start a new run after refreshing the library.',
        );
      if (page.nextCursor) cursors.add(page.nextCursor);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && live(run));
    if (live(run)) discovered = true;
  }
  async function execute() {
    if (disposed || denied || busy() || !scope) return;
    const run = ++epoch;
    request = new AbortController();
    const signal = request.signal;
    let changed = false;
    update({ phase: discovered ? 'running' : 'discovering', failure: null });
    try {
      if (!discovered) await discover(run, signal);
      if (!live(run)) return;
      update({ phase: 'running' });
      for (const next of current.rows) {
        if (!live(run)) return;
        if (next.status !== 'pending' || !next.entry.source) continue;
        const id = next.entry.id;
        row(id, { status: 'working', reason: 'Finding matches…', retryable: false });
        try {
          let saved = await client.sourceSelections(id, signal);
          if (!live(run)) return;
          const checksum = canChecksum(next.entry.source);
          const result = await client.sourceMatches(id, { ...current.options, checksum }, signal);
          if (!live(run)) return;
          const { auto } = plan(result, saved, checksum);
          let count = next.saved;
          for (const candidate of auto) {
            if (!live(run)) return;
            // Each response may reveal another owner's choice. Recheck both
            // category occupancy and system agreement before the next write.
            if (!plan(result, saved, checksum).auto.some((choice) => choice.id === candidate.id))
              continue;
            saved = await client.saveSourceMatch(
              id,
              result.requestId,
              candidate.id,
              saved.revision,
              signal,
            );
            if (!live(run)) return;
            changed = true;
            count++;
            row(id, { saved: count });
          }
          const remaining = plan(result, saved, checksum).remaining;
          const review = remaining.length > 0 || result.problems.length > 0;
          row(id, {
            status: review ? 'review' : saved.matches.length ? 'saved' : 'unmatched',
            suggestions: remaining.length,
            retryable: result.problems.length > 0,
            reason: result.problems.length
              ? 'Some providers failed; review these results or retry later.'
              : review
                ? 'Choose between suggestions. Filename matches are never auto-saved.'
                : count
                  ? `${count} exact checksum match${count === 1 ? '' : 'es'} saved.`
                  : saved.matches.length
                    ? 'Existing saved choices preserved.'
                    : 'No suggestions from the selected providers.',
          });
        } catch (error) {
          if (!live(run)) return;
          if (reject(error)) return;
          row(id, { status: 'failed', reason: explain(error), retryable: true });
        }
      }
      if (live(run)) update({ phase: 'complete' });
    } catch (error) {
      if (live(run) && !reject(error)) update({ phase: 'paused', failure: explain(error) });
    } finally {
      if (live(run) && changed) hooks.changed?.();
    }
  }
  function reset() {
    epoch++;
    request?.abort();
    discovered = false;
    scope = null;
    update(initial());
  }
  return {
    subscribe: store.subscribe,
    async start(selected, options) {
      if (disposed || denied || busy()) return;
      reset();
      scope = { ...selected };
      update({
        options: {
          ...options,
          ...(options.providerIds ? { providerIds: [...options.providerIds] } : {}),
        },
      });
      await execute();
    },
    resume: execute,
    async retryFailures() {
      if (disposed || denied || busy()) return;
      update({
        rows: current.rows.map((r) =>
          r.retryable ? { ...r, status: 'pending', reason: '', retryable: false } : r,
        ),
      });
      await execute();
    },
    reviewed(id) {
      if (!disposed && !denied)
        row(id, { status: 'reviewed', reason: 'Review complete.', retryable: false });
    },
    pause() {
      if (disposed || denied || !busy()) return;
      epoch++;
      request?.abort();
      update({
        phase: 'paused',
        rows: current.rows.map((r) =>
          r.status === 'working' ? { ...r, status: 'pending', reason: '' } : r,
        ),
      });
      hooks.changed?.();
    },
    reset,
    dispose() {
      disposed = true;
      reset();
    },
  };
}
