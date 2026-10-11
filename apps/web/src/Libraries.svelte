<script lang="ts">
  import type { ContentClient, Item, Library } from '@ecs/client';
  import { explain } from './lib/problems';

  let { client }: { client: ContentClient } = $props();

  let libraries = $state<Library[]>([]);
  let selected = $state<string | null>(null);
  let items = $state<Item[]>([]);
  let failure = $state<string | null>(null);

  async function load(): Promise<void> {
    try {
      libraries = (await client.libraries()).items;
      selected ??= libraries[0]?.id ?? null;
      await loadItems();
    } catch (error) {
      failure = explain(error);
    }
  }

  async function loadItems(): Promise<void> {
    if (!selected) {
      items = [];
      return;
    }
    try {
      items = (await client.items({ libraryId: selected, limit: 50 })).items;
    } catch (error) {
      failure = explain(error);
    }
  }

  void load();
</script>

<section>
  <div class="row">
    <h2>Libraries</h2>
    {#if libraries.length > 1}
      <select bind:value={selected} onchange={loadItems}>
        {#each libraries as library (library.id)}
          <option value={library.id}>{library.name}</option>
        {/each}
      </select>
    {/if}
  </div>
  {#if items.length === 0}
    <p class="dim">No items yet. Add a folder below, or upload from a device.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Title</th><th>System</th><th>Revision</th></tr>
      </thead>
      <tbody>
        {#each items as item (item.id)}
          <tr>
            <td>{item.title}</td>
            <td class="dim"><code>{item.systemIdentifier}</code></td>
            <td class="dim">{item.revision}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  {#if failure}
    <p class="problem">{failure}</p>
  {/if}
</section>
