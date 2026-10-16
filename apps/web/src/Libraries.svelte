<script lang="ts">
  import type { ContentClient, Item, Library } from '@ecs/client';
  import Files from './Files.svelte';
  import { explain } from './lib/problems';
  import Upload from './Upload.svelte';

  let { client }: { client: ContentClient } = $props();

  let libraries = $state<Library[]>([]);
  let selected = $state<string | null>(null);
  let items = $state<Item[]>([]);
  /** The opened item, whose files and uploads are shown below the list. */
  let active = $state<Item | null>(null);
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

  function choose(library: string): void {
    selected = library;
    active = null;
    void loadItems();
  }

  /**
   * An upload advances the item revision, and the next one needs that revision
   * to be accepted, so the opened item is replaced with what the server now has.
   */
  async function refresh(): Promise<void> {
    const opened = active?.id;
    await loadItems();
    active = items.find((item) => item.id === opened) ?? null;
  }

  /**
   * Walks the change feed to the present, then reloads whenever a later page
   * carries something new, so a save that arrived from a phone shows up here.
   */
  async function watch(): Promise<void> {
    let cursor = '0';
    let primed = false;
    for (;;) {
      try {
        const page = await client.changes({ cursor, limit: 100 });
        const caughtUp = page.changes.length === 0 || page.nextCursor === cursor;
        cursor = page.nextCursor;
        if (!primed) {
          if (!caughtUp) continue;
          primed = true;
        } else if (!caughtUp) {
          await refresh();
        }
      } catch (error) {
        failure = explain(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  }

  void load();
  void watch();
</script>

<section>
  <div class="row">
    <h2>Libraries</h2>
    {#if libraries.length > 1}
      <select
        value={selected}
        onchange={(event) => choose((event.currentTarget as HTMLSelectElement).value)}
      >
        {#each libraries as library (library.id)}
          <option value={library.id}>{library.name}</option>
        {/each}
      </select>
    {/if}
  </div>
  {#if items.length === 0}
    <p class="dim">No items yet. Upload one below, or add a folder to scan.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Title</th><th>System</th><th>Revision</th><th></th></tr>
      </thead>
      <tbody>
        {#each items as item (item.id)}
          <tr>
            <td>{item.title}</td>
            <td class="dim"><code>{item.systemIdentifier}</code></td>
            <td class="dim">{item.revision}</td>
            <td>
              <button
                type="button"
                onclick={() => (active = active?.id === item.id ? null : item)}
              >
                {active?.id === item.id ? 'Close' : 'Open'}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  {#if failure}
    <p class="problem">{failure}</p>
  {/if}
</section>

{#if active}
  {#key `${active.id}:${active.revision}`}
    <Files {client} item={active} />
  {/key}
{/if}

{#if selected}
  <Upload {client} libraryId={selected} item={active} oncomplete={refresh} />
{/if}
