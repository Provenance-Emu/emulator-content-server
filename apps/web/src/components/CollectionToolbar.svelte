<script lang="ts">
  import type { ContentRootSummary, SystemSummary, SystemCount } from '@ecs/client';
  import { systemLabel } from '../lib/content-format';
  import type { BrowseFilters } from '../lib/library-browser';
  let {
    filters,
    systems,
    folders,
    systemCounts,
    onchange,
  }: {
    filters: BrowseFilters;
    systems: SystemSummary[];
    folders: ContentRootSummary[];
    systemCounts: SystemCount[];
    onchange: (patch: Partial<BrowseFilters>) => void;
  } = $props();
  let expanded = $state(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 761px)').matches,
  );
  const activeFilters = $derived(
    filters.systemIds.length + (filters.systemId ? 1 : 0) + (filters.rootId ? 1 : 0),
  );
  let search = $state('');
  let lastSearch: string | undefined;
  $effect(() => {
    const committed = filters.search;
    // A page/summary refresh must not replace a draft that the user is still typing.
    if (committed !== lastSearch) {
      search = committed;
      lastSearch = committed;
    }
  });
</script>

<div class="collection-toolbar">
  <form
    role="search"
    onsubmit={(event) => {
      event.preventDefault();
      onchange({ search: search.trim() });
    }}
  >
    <label class="search-field">
      Search collection
      <input type="search" bind:value={search} placeholder="Find a game by name" />
    </label>
    <button type="submit">Search</button>
  </form>
  <details class="collection-options" bind:open={expanded}>
    <summary>Filter &amp; sort{#if activeFilters} <span class="filter-count">{activeFilters} active</span>{/if}</summary>
    <div class="collection-option-fields">
      <fieldset class="system-filter">
        <legend>Systems with games</legend>
        <div class="system-chips">
          <button type="button" aria-pressed={filters.systemIds.length === 0} onclick={() => onchange({systemIds:[],systemId:''})}>All systems</button>
          {#each systemCounts as system (system.systemId)}
            <button type="button" aria-pressed={filters.systemIds.includes(system.systemId)} onclick={() => onchange({systemIds:filters.systemIds.includes(system.systemId) ? filters.systemIds.filter(id=>id!==system.systemId) : [...filters.systemIds,system.systemId]})}>
              {systemLabel(system.systemId,systems)} <span class="system-count">{system.count}</span>
            </button>
          {/each}
          {#if filters.systemIds.length}<button type="button" class="text-button" onclick={() => onchange({systemIds:[],systemId:''})}>Clear systems</button>{/if}
        </div>
      </fieldset>
      {#if folders.length || filters.rootId}<label>
          Library folder
          <select
            value={filters.rootId}
            onchange={(event) => onchange({ rootId: event.currentTarget.value })}
          >
            <option value="">All folders</option>
            {#each folders as summary (summary.root.id)}<option value={summary.root.id}>
                {summary.root.label}
              </option>{/each}
          </select>
        </label>{/if}
      <label>
        Sort
        <select
          value={filters.sort}
          onchange={(event) => onchange({ sort: event.currentTarget.value as BrowseFilters['sort'] })}
        >
          <option value="name_asc">Name A–Z</option>
          <option value="name_desc">Name Z–A</option>
        </select>
      </label>
      <fieldset class="view-switch">
        <legend>Collection view</legend>
        {#each ['grid', 'list'] as view}<label>
            <input
              type="radio"
              name="collection-view"
              value={view}
              checked={filters.view === view}
              onchange={() => onchange({ view: view as 'grid' | 'list' })}
            />
            {view === 'grid' ? 'Grid' : 'List'}
          </label>{/each}
      </fieldset>
    </div>
  </details>
  {#if filters.search || filters.systemId || filters.systemIds.length || filters.rootId}<button
      type="button"
      onclick={() => onchange({ search: '', systemId: '', systemIds: [], rootId: '' })}
    >
      Clear filters
    </button>{/if}
</div>
