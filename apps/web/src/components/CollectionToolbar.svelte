<script lang="ts">
  import type { ContentRootSummary, SystemSummary } from '@ecs/client';
  import type { BrowseFilters } from '../lib/library-browser';
  let {
    filters,
    systems,
    folders,
    onchange,
  }: {
    filters: BrowseFilters;
    systems: SystemSummary[];
    folders: ContentRootSummary[];
    onchange: (patch: Partial<BrowseFilters>) => void;
  } = $props();
  let search = $state('');
  $effect(() => {
    search = filters.search;
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
      <input type="search" bind:value={search} />
    </label>
    <button type="submit">Search</button>
  </form>
  <label>
    System filter
    <select
      value={filters.systemId}
      onchange={(event) => onchange({ systemId: event.currentTarget.value })}
    >
      <option value="">All systems</option>
      <option value="unknown">Unknown system</option>
      {#each systems as system (system.identifier)}<option value={system.identifier}>
          {system.name}
        </option>{/each}
    </select>
  </label>
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
      <option value="name_asc">Name ascending</option>
      <option value="name_desc">Name descending</option>
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
  {#if filters.search || filters.systemId || filters.rootId}<button
      type="button"
      onclick={() => onchange({ search: '', systemId: '', rootId: '' })}
    >
      Clear filters
    </button>{/if}
</div>
