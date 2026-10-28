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
    onrejected,
    context, onrename,
    mode = 'libraries',
  }: {
    client: ContentClient;
    libraries: Library[];
    invalidation: number;
    onrejected: (status: 401 | 403) => void;
    onview: (rootId: string, libraryId: string | null) => void;
    mode?: 'libraries' | 'folders';
    context: FolderContext; onrename: (library: Library) => void;
  } = $props();
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
    {#if mode === 'libraries'}<p class="eyebrow">Settings</p><h1>Libraries</h1>
    {:else}<h2>Folders on server</h2>{/if}
    <p class="dim">
      {mode === 'libraries' ? 'A library is a named collection with its own access permissions. Link folders to decide which games belong to it.' : 'These folders supply existing game files. Choose a library, add a folder on the server computer, and scan it. Files stay where they are.'}
    </p>
  </div>
  <button type="button" disabled={loading} onclick={() => void load()}>Refresh summaries</button>
</header>
{#if failure}<p class="problem" role="alert">{failure}</p>{/if}
{#if !rejected}
<UnassignedFolders {client} {context} {libraries} cached={summaries.filter(row=>row.root.libraryId===null)} {onview} />
{#each libraries as library (library.id)}<section>
    <h2>{library.name}</h2>
    {#if mode === 'libraries'}<button type="button" aria-label={`Rename ${library.name}`} onclick={() => onrename(library)}>Rename library</button>{/if}
    <LibraryFolders {client} {context} {library} {libraries}
      summaries={summaries.filter((summary) => summary.root.libraryId === library.id)}
      {onview}
    />
  </section>{/each}
<section>
  <h2>Unassigned folders</h2>
  <p class="dim">These folders are not linked to a library yet. Choose a library above to scan and display their games.</p>
  <LibraryFolders {client} {context} {libraries}
    summaries={summaries.filter((summary) => summary.root.libraryId === null)}
    {onview}
  />
</section>{/if}
