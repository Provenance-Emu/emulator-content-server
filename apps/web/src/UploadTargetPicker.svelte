<script lang="ts">
  import { ContentError, type ContentClient, type Item } from '@ecs/client';
  import { onDestroy } from 'svelte';
  import ListMore from './components/ListMore.svelte';
  import { shownLabel } from './lib/batches';
  import { explain } from './lib/problems';
  let {
    client,
    libraryId,
    onchoose,
    oncancel,
    onauthorization = () => {},
  }: {
    client: ContentClient;
    libraryId: string;
    onchoose: (item: Item) => void;
    oncancel: () => void;
    onauthorization?: (status: 401 | 403) => void;
  } = $props();
  let items = $state<Item[]>([]);
  let next = $state<string | null>(null);
  let loading = $state(false);
  let failure = $state<string | null>(null);
  let disposed = false;
  let denied = $state(false);
  /** Reads the first batch, or the one after what is already listed. */
  async function load(cursor?: string) {
    if (loading || disposed || denied) return;
    loading = true;
    failure = null;
    try {
      const result = await client.items({ libraryId, cursor, limit: 50 });
      if (disposed) return;
      const listed = new Set(cursor ? items.map((item) => item.id) : []);
      const added = result.items.filter((i) => i.libraryId === libraryId && !listed.has(i.id));
      items = cursor ? [...items, ...added] : added;
      next = result.nextCursor;
    } catch (error) {
      if (disposed) return;
      failure = explain(error);
      if (error instanceof ContentError && (error.status === 401 || error.status === 403)) {
        items = [];
        next = null;
        denied = true;
        onauthorization(error.status);
      }
    } finally {
      if (!disposed) loading = false;
    }
  }
  onDestroy(() => {
    disposed = true;
  });
  void load();
</script>
<section aria-label="Choose managed item">
  <h3>Choose an existing managed item</h3>
  <p>Check the item ID. Scanned server-folder files are not upload targets.</p>
  {#each items as item (item.id)}
    <button type="button" disabled={denied} onclick={()=>{if(!denied)onchoose(item);}}>{item.title} · {item.systemIdentifier} · ID {item.id}</button>
  {/each}
  {#if !loading && !items.length && !next && !failure}<p>No managed items in this library.</p>{/if}
  {#if failure}<p role="alert" class="problem">{failure}</p>{/if}
  {#if items.length || next}<ListMore
      label={shownLabel(items.length, !!next, ['managed item', 'managed items'])}
      more={!!next && !denied}
      busy={loading}
      failed={!!failure}
      action="Show more items"
      onmore={() => void load(next ?? undefined)}
    />
  {:else if failure}<button type="button" disabled={denied || loading} onclick={()=>void load()}>Retry item list</button>{/if}
  <button type="button" onclick={oncancel}>Close item picker</button>
</section>
