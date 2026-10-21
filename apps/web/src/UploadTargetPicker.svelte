<script lang="ts">
  import type { ContentClient, Item } from '@ecs/client';
  import { onDestroy } from 'svelte';
  import { explain } from './lib/problems';
  let {
    client,
    libraryId,
    onchoose,
    oncancel,
  }: {
    client: ContentClient;
    libraryId: string;
    onchoose: (item: Item) => void;
    oncancel: () => void;
  } = $props();
  let items = $state<Item[]>([]);
  let cursors: (string | undefined)[] = [undefined];
  let index = $state(0);
  let next = $state<string | null>(null);
  let loading = $state(false);
  let failure = $state<string | null>(null);
  let disposed = false;
  async function load(page: number) {
    if (loading || disposed) return;
    loading = true;
    failure = null;
    try {
      const result = await client.items({ libraryId, cursor: cursors[page], limit: 50 });
      if (disposed) return;
      items = result.items.filter((i) => i.libraryId === libraryId);
      index = page;
      next = result.nextCursor;
    } catch (error) {
      if (!disposed) failure = explain(error);
    } finally {
      if (!disposed) loading = false;
    }
  }
  onDestroy(() => {
    disposed = true;
  });
  void load(0);
</script>
<section aria-label="Choose managed item">
  <h3>Choose an existing managed item</h3>
  <p>Check the item ID. Scanned server-folder files are not upload targets.</p>
  {#each items as item (item.id)}
    <button type="button" disabled={loading} onclick={()=>onchoose(item)}>{item.title} · {item.systemIdentifier} · ID {item.id}</button>
  {/each}
  {#if !loading && !items.length}<p>No managed items on this page.</p>{/if}
  {#if failure}<p role="alert" class="problem">{failure}</p><button type="button" onclick={()=>void load(index)}>Retry item list</button>{/if}
  <nav aria-label="Managed item pages">
    <button type="button" disabled={loading || index===0} onclick={()=>void load(index-1)}>Previous items</button>
    <span>Page {index+1}</span>
    <button type="button" disabled={loading || !next} onclick={()=>{cursors[index+1]=next??undefined;void load(index+1);}}>Next items</button>
  </nav>
  <button type="button" onclick={oncancel}>Close item picker</button>
</section>
