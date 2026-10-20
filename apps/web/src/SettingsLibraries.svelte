<script lang="ts">
  import type { ContentClient, ContentRootSummary, Library } from '@ecs/client';
  import { onDestroy, untrack } from 'svelte';
  import LibraryFolders from './LibraryFolders.svelte';
  import type { FolderContext } from './lib/folder-selection';
  import { explain, isForbidden, isUnauthorized } from './lib/problems';
  let {
    client,
    libraries,
    invalidation,
    onview,
    onrejected,
    context, onrename,
  }: {
    client: ContentClient;
    libraries: Library[];
    invalidation: number;
    onrejected: (status: 401 | 403) => void;
    onview: (rootId: string, libraryId: string | null) => void;
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
    <p class="eyebrow">Settings</p>
    <h1>Libraries</h1>
    <p class="dim">
      Files in these server folders appear in your libraries. They stay where they are.
    </p>
  </div>
  <button type="button" disabled={loading} onclick={() => void load()}>Refresh summaries</button>
</header>
{#if failure}<p class="problem" role="alert">{failure}</p>{/if}
{#if !rejected}{#each libraries as library (library.id)}<section>
    <h2>{library.name}</h2>
    <button type="button" aria-label={`Rename ${library.name}`} onclick={() => onrename(library)}>Rename library</button>
    <LibraryFolders {client} {context} {library} {libraries}
      summaries={summaries.filter((summary) => summary.root.libraryId === library.id)}
      {onview}
    />
  </section>{/each}
<section>
  <h2>Unassigned folders</h2>
  <p class="dim">These legacy folders have no library association. Their files stay in place.</p>
  <LibraryFolders {client} {context} {libraries}
    summaries={summaries.filter((summary) => summary.root.libraryId === null)}
    {onview}
  />
</section>{/if}
