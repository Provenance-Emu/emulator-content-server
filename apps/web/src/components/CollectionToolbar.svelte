<script lang="ts">
  import type { ContentRootSummary, SystemSummary, SystemCount } from '@ecs/client';
  import { onDestroy, tick } from 'svelte';
  import { systemLabel } from '../lib/content-format';
  import { COVER_SIZE, coverSize, setCoverSize } from '../lib/cover-size';
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
  let search = $state('');
  let lastSearch: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const committed = filters.search;
    // A refresh, or the echo of what was just typed, must not replace the draft being typed.
    if (committed !== lastSearch) {
      search = committed;
      lastSearch = committed;
    }
  });
  function commit() {
    clearTimeout(timer);
    const value = search.trim();
    lastSearch = value;
    if (value !== filters.search) onchange({ search: value });
  }
  /** The list follows the typing after a short pause; Enter applies it at once. */
  function typed() {
    clearTimeout(timer);
    timer = setTimeout(commit, 250);
  }
  onDestroy(() => clearTimeout(timer));

  const chosen = $derived(
    filters.systemIds.length ? filters.systemIds : filters.systemId ? [filters.systemId] : [],
  );
  const filtered = $derived(!!(filters.search || chosen.length || filters.rootId));
  /** One click shows one system. Shift, Ctrl or Command adds to or removes from the choice. */
  function choose(id: string, event: MouseEvent) {
    if (event.shiftKey || event.ctrlKey || event.metaKey)
      onchange({
        systemIds: chosen.includes(id) ? chosen.filter((value) => value !== id) : [...chosen, id],
      });
    else onchange({ systemIds: chosen.length === 1 && chosen[0] === id ? [] : [id] });
  }
  let chips = $state<HTMLDivElement>();
  let expanded = $state(false);
  let overflowing = $state(false);
  function measure() {
    if (!chips || expanded) return;
    overflowing = chips.scrollHeight > chips.clientHeight + 1;
    const bottom = chips.getBoundingClientRect().bottom;
    const pressed = Array.from(chips.querySelectorAll<HTMLElement>('[aria-pressed="true"]'));
    // A chosen system never sits in the folded rows.
    if (overflowing && pressed.some((chip) => chip.getBoundingClientRect().top >= bottom - 1))
      expanded = true;
    // On a phone the row scrolls sideways instead.
    else if (chips.scrollWidth > chips.clientWidth + 1)
      pressed[0]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  $effect(() => {
    void systemCounts;
    void chosen;
    void expanded;
    void tick().then(measure);
  });
  $effect(() => {
    if (!chips || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(chips);
    return () => observer.disconnect();
  });
</script>

<div class="collection-toolbar">
  <form
    role="search"
    onsubmit={(event) => {
      event.preventDefault();
      commit();
    }}
  >
    <label class="search-field">
      <span class="visually-hidden">Search collection</span>
      <input type="search" bind:value={search} oninput={typed} placeholder="Name or file type, like chd" />
    </label>
  </form>
  <div class="collection-view-options">
    {#if folders.length || filters.rootId}<label class="toolbar-select">
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
    <label class="toolbar-select">
      Sort
      <select
        value={filters.sort}
        onchange={(event) => onchange({ sort: event.currentTarget.value as BrowseFilters['sort'] })}
      >
        <option value="name_asc">Name A–Z</option>
        <option value="name_desc">Name Z–A</option>
      </select>
    </label>
    {#if filters.view === 'grid'}<label class="toolbar-select cover-size">
        Cover size
        <input
          type="range"
          min={COVER_SIZE.min}
          max={COVER_SIZE.max}
          step={COVER_SIZE.step}
          value={$coverSize}
          oninput={(event) => setCoverSize(Number(event.currentTarget.value))}
        />
      </label>{/if}
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
  {#if systemCounts.length || filtered}
    <fieldset class="system-filter">
      <legend class="visually-hidden">Systems with games</legend>
      <div class="system-chips" class:folded={!expanded} bind:this={chips}>
        <button type="button" aria-pressed={chosen.length === 0} onclick={() => onchange({ systemIds: [], systemId: '' })}>All systems</button>
        {#each systemCounts as system (system.systemId)}
          <button type="button" aria-pressed={chosen.includes(system.systemId)} onclick={(event) => choose(system.systemId, event)}>
            {systemLabel(system.systemId, systems)} <span class="system-count">{system.count}</span>
          </button>
        {/each}
      </div>
      {#if overflowing || expanded}<button type="button" class="text-button system-more" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>{expanded ? 'Fewer systems' : 'More systems'}</button>{/if}
      {#if filtered}<button type="button" class="text-button" onclick={() => { clearTimeout(timer); onchange({ search: '', systemId: '', systemIds: [], rootId: '' }); }}>Clear filters</button>{/if}
    </fieldset>
  {/if}
</div>
