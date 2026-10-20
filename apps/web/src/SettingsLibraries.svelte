<script lang="ts">
  import type { ContentClient, ContentRootSummary, Library } from '@ecs/client';
  import { onDestroy } from 'svelte';
  import FolderSummaryRows from './components/FolderSummaryRows.svelte';
  import { explain } from './lib/problems';
  let {
    client,
    libraries,
    invalidation,
    onview,
  }: {
    client: ContentClient;
    libraries: Library[];
    invalidation: number;
    onview: (rootId: string, libraryId: string | null) => void;
  } = $props();
  let summaries = $state<ContentRootSummary[]>([]);
  let failure = $state<string | null>(null);
  let generation = 0;
  let loading = $state(false);
  async function load() {
    const run = ++generation;
    loading = true;
    try {
      const result = await client.rootSummaries();
      if (run === generation) {
        summaries = result.items;
        failure = null;
      }
    } catch (error) {
      if (run === generation) failure = explain(error);
    } finally {
      if (run === generation) loading = false;
    }
  }
  $effect(() => {
    void invalidation;
    void load();
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
{#each libraries as library (library.id)}<section>
    <h2>{library.name}</h2>
    <FolderSummaryRows
      summaries={summaries.filter((summary) => summary.root.libraryId === library.id)}
      {onview}
    />
  </section>{/each}
<section>
  <h2>Unassigned folders</h2>
  <p class="dim">These legacy folders have no library association. Their files stay in place.</p>
  <FolderSummaryRows
    summaries={summaries.filter((summary) => summary.root.libraryId === null)}
    {onview}
  />
</section>
