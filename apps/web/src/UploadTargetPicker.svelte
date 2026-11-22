<script lang="ts">
  import {
    ContentError,
    type ContentClient,
    type Item,
    type LibraryBrowseEntry,
    type SystemSummary,
  } from '@ecs/client';
  import { onDestroy, untrack } from 'svelte';
  import Icon from './components/Icon.svelte';
  import ListMore from './components/ListMore.svelte';
  import { shownLabel } from './lib/batches';
  import { entryKey, systemLabel } from './lib/content-format';
  import { createPreviews } from './lib/previews';
  import { explain } from './lib/problems';
  let {
    client,
    libraryId,
    systems = [],
    heading = 'Which game are these for?',
    onchoose,
    oncancel,
    onauthorization = () => {},
  }: {
    client: ContentClient;
    libraryId: string;
    systems?: SystemSummary[];
    heading?: string;
    onchoose: (item: Item) => void;
    oncancel: () => void;
    onauthorization?: (status: 401 | 403) => void;
  } = $props();
  /** A batch can be all server-folder games; read a few more before saying nothing was found. */
  const BATCHES_PER_READ = 4;
  let games = $state<LibraryBrowseEntry[]>([]);
  let next = $state<string | null>(null);
  let query = $state('');
  let loading = $state(false);
  let failure = $state<string | null>(null);
  let denied = $state(false);
  /** Games that live in a server folder were left out of what is listed. */
  let skipped = $state(false);
  let disposed = false;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const previews = untrack(() => createPreviews(client));
  /** Reads the first games for the current search, or the ones after what is listed. */
  async function load(more: boolean) {
    if (disposed || denied || (more && (loading || !next))) return;
    const run = more ? epoch : ++epoch;
    const search = query.trim();
    loading = true;
    failure = null;
    try {
      let cursor = more ? (next ?? undefined) : undefined;
      const found: LibraryBrowseEntry[] = [];
      let left = false;
      for (let batch = 0; batch < BATCHES_PER_READ; batch++) {
        const page = await client.browse({
          libraryId,
          category: 'games',
          limit: 50,
          ...(search ? { search } : {}),
          ...(cursor ? { cursor } : {}),
        });
        if (disposed || run !== epoch) return;
        for (const entry of page.items) {
          // Files can only be added to a game that was uploaded to this library.
          if (entry.entityType === 'item' && entry.item?.libraryId === libraryId) found.push(entry);
          else left = true;
        }
        cursor = page.nextCursor ?? undefined;
        if (!cursor || found.length) break;
      }
      const listed = new Set(more ? games.map(entryKey) : []);
      const added = found.filter((entry) => !listed.has(entryKey(entry)));
      games = more ? [...games, ...added] : added;
      skipped = more ? skipped || left : left;
      next = cursor ?? null;
      previews.request(added);
    } catch (error) {
      if (disposed || run !== epoch) return;
      failure = explain(error);
      if (error instanceof ContentError && (error.status === 401 || error.status === 403)) {
        games = [];
        next = null;
        denied = true;
        onauthorization(error.status);
      }
    } finally {
      if (!disposed && run === epoch) loading = false;
    }
  }
  function searched() {
    clearTimeout(timer);
    timer = setTimeout(() => void load(false), 250);
  }
  onDestroy(() => {
    disposed = true;
    clearTimeout(timer);
    previews.dispose();
  });
  void load(false);
</script>

<section class="game-picker" aria-label="Choose a game">
  <header class="picker-head">
    <h3>{heading}</h3>
    <button type="button" class="icon-only" aria-label="Close game list" title="Close" onclick={oncancel}>
      <Icon name="close" />
    </button>
  </header>
  <input
    type="search"
    aria-label="Search games"
    placeholder="Search games"
    bind:value={query}
    oninput={searched}
    onkeydown={(event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      clearTimeout(timer);
      void load(false);
    }}
  />
  <div class="picker-scroll">
    <ul class="picker-list">
      {#each games as entry (entry.id)}
        <li>
          <button
            type="button"
            class="picker-row"
            data-item-id={entry.id}
            disabled={denied}
            onclick={() => {
              if (!denied && entry.item) onchoose(entry.item);
            }}
          >
            <span class="picker-cover artwork" aria-hidden="true">
              {#if $previews.urls[entryKey(entry)]}<img src={$previews.urls[entryKey(entry)]} alt="" decoding="async" />
              {:else}<span class="picker-initial">{entry.name.trim().charAt(0).toUpperCase() || '?'}</span>{/if}
            </span>
            <span class="picker-name">
              <strong>{entry.name}</strong>
              <span class="dim">{systemLabel(entry.systemId, systems)}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
    {#if loading && !games.length}<p class="dim" role="status">Looking for games…</p>{/if}
    {#if !loading && !games.length && !failure}
      <p class="dim">
        {query.trim() ? `No uploaded game matches “${query.trim()}”.` : 'No games have been uploaded to this library yet.'}
      </p>
    {/if}
    {#if failure}<p role="alert" class="problem">{failure}</p>{/if}
    {#if games.length || next}
      <ListMore
        label={shownLabel(games.length, !!next, ['game', 'games'])}
        more={!!next && !denied}
        busy={loading}
        failed={!!failure}
        action="Show more games"
        onmore={() => void load(true)}
      />
    {:else if failure}
      <button type="button" disabled={denied || loading} onclick={() => void load(false)}>Try again</button>
    {/if}
  </div>
  {#if skipped}
    <p class="dim picker-note">
      Games kept in a server folder are not listed. Files can be added to games uploaded to this library.
    </p>
  {/if}
</section>

<style>
  .game-picker {
    display: grid;
    gap: var(--space-3);
    margin-block: var(--space-3);
    padding: var(--space-4);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-panel);
    background: var(--color-surface);
  }
  .picker-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .picker-head h3 {
    margin: 0;
    font-size: var(--text-body);
  }
  .game-picker input {
    width: 100%;
  }
  .picker-scroll {
    max-height: min(22rem, 48vh);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .picker-list {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .picker-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-1) var(--space-2);
    border-color: transparent;
    background: transparent;
    box-shadow: none;
    text-align: left;
  }
  .picker-row:hover {
    background: var(--color-hover);
  }
  .picker-cover {
    display: grid;
    flex: 0 0 2.5rem;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    overflow: hidden;
    border-radius: var(--radius-sm);
    background: var(--color-surface-inset);
  }
  .picker-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .picker-initial {
    color: var(--color-text-muted);
    font-weight: 600;
  }
  .picker-name {
    display: grid;
    min-width: 0;
  }
  .picker-name strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .picker-name .dim {
    font-size: var(--text-small);
  }
  .picker-note {
    margin: 0;
    font-size: var(--text-small);
  }
</style>
