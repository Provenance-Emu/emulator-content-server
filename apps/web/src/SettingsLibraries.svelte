<script lang="ts">
  import type { ContentClient, ContentRootSummary, Library } from '@ecs/client';
  import { onDestroy, untrack } from 'svelte';
  import LibraryFolders from './LibraryFolders.svelte';
  import UnassignedFolders from './UnassignedFolders.svelte';
  import type { FolderContext } from './lib/folder-selection';
  import { explain, isForbidden, isUnauthorized } from './lib/problems';
  let {
    client,
    libraries,
    invalidation,
    onview,
    onmaintenance,
    onrejected,
    context, onrename,
    mode = 'libraries',
    libraryId = $bindable(''),
    onlibrarychange = () => {},
  }: {
    client: ContentClient;
    libraries: Library[];
    invalidation: number;
    onrejected: (status: 401 | 403) => void;
    onview: (rootId: string, libraryId: string | null) => void;
    onmaintenance: () => void;
    mode?: 'libraries' | 'folders';
    libraryId?: string;
    onlibrarychange?: () => void;
    context: FolderContext; onrename: (library: Library) => void;
  } = $props();
  const selectedLibrary = $derived(libraries.find(library => library.id === libraryId));
  const displayedLibraries = $derived(libraryId ? libraries.filter(library => library.id === libraryId) : libraries);
  let summaries = $state<ContentRootSummary[]>([]);
  let failure = $state<string | null>(null);
  let generation = 0;
  let loading = $state(false);
  let rejected = $state(false);
  let lastInvalidation = -1;
  async function load() {
    const run = ++generation;
    rejected = false;
    loading = true;
    try {
      const result = await client.rootSummaries();
      if (run === generation) {
        summaries = result.items;
        failure = null;
      }
    } catch (error) {
      if (run !== generation) return;
      failure = explain(error);
      if (isUnauthorized(error) || isForbidden(error)) {
        generation++;
        summaries = [];
        loading = false;
        rejected = true;
        onrejected(isUnauthorized(error) ? 401 : 403);
      }
    } finally {
      if (run === generation) loading = false;
    }
  }
  $effect(() => {
    const signal = invalidation;
    untrack(() => {
      if (signal === lastInvalidation) return;
      lastInvalidation = signal;
      if (!rejected) void load();
    });
  });
  onDestroy(() => {
    generation++;
    summaries = [];
  });
</script>

<header class="page-heading">
  <div>
    {#if mode === 'libraries'}<p class="eyebrow">{selectedLibrary ? 'Library settings' : 'Collection'}</p><h1>{selectedLibrary?.name ?? 'Libraries'}</h1>
    {:else}<h2>Folders on server</h2>{/if}
    <p class="dim">
      {selectedLibrary ? 'Manage the folders that supply this library.' : 'Choose a library to manage its folders and indexed games.'}
    </p>
  </div>
  <div class="actions">
    {#if selectedLibrary && mode === 'libraries'}<button type="button" aria-label={`Rename ${selectedLibrary.name}`} onclick={() => onrename(selectedLibrary)}>Rename library</button>{/if}
    <button type="button" disabled={loading} onclick={() => void load()}>Refresh summaries</button>
    <button type="button" onclick={onmaintenance}>Open Scans &amp; details</button>
  </div>
</header>
{#if failure}<p class="problem" role="alert">{failure}</p>{/if}
{#if !rejected}
{#if mode === 'libraries'}<label class="settings-library-picker">
  Library
  <select value={libraryId} onchange={event => {
    libraryId = event.currentTarget.value;
    onlibrarychange();
  }}>
    <option value="">All libraries</option>
    {#each libraries as library}<option value={library.id}>{library.name}</option>{/each}
  </select>
</label>{/if}
{#each displayedLibraries as library (library.id)}<section>
    <h2>{selectedLibrary ? 'Game folders' : library.name}</h2>
    {#if mode === 'libraries' && !selectedLibrary}<button type="button" aria-label={`Rename ${library.name}`} onclick={() => onrename(library)}>Rename library</button>{/if}
    <LibraryFolders {client} {context} {library} {libraries}
      summaries={summaries.filter((summary) => summary.root.libraryId === library.id)}
      {onview}
    />
  </section>{/each}
<details class="settings-unassigned" open={!libraries.length} hidden={!!libraryId}>
  <summary>Unassigned folders</summary>
  <UnassignedFolders {client} {context} {libraries} cached={summaries.filter(row=>row.root.libraryId===null)} {onview} />
  <p class="dim">These folders are not linked to a library yet. Choose a library above to scan and display their games.</p>
  <LibraryFolders {client} {context} {libraries}
    summaries={summaries.filter((summary) => summary.root.libraryId === null)}
    {onview}
  />
</details>{/if}
