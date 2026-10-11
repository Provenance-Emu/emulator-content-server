<script lang="ts">
  import type { ContentClient, Item, SystemSummary } from '@ecs/client';
  import { bytes } from './lib/format';
  import { explain } from './lib/problems';

  let {
    client,
    libraryId,
    item,
    oncomplete,
  }: {
    client: ContentClient;
    libraryId: string;
    /** The item to add a file to, or null to create one from this upload. */
    item: Item | null;
    oncomplete: () => void;
  } = $props();

  /** Pieces this size keep progress moving and bound what a break costs. */
  const CHUNK_BYTES = 4 * 1024 * 1024;
  const KINDS = [
    'rom',
    'battery_save',
    'save_state',
    'screenshot',
    'artwork',
    'bios',
    'system_file',
  ];

  let field: HTMLInputElement | null = $state(null);
  let chosen = $state<File | null>(null);
  let kind = $state('rom');
  let title = $state('');
  let system = $state('');
  let systems = $state<SystemSummary[]>([]);
  let sent = $state(0);
  let working = $state(false);
  let failure = $state<string | null>(null);

  let percent = $derived(chosen && chosen.size > 0 ? Math.round((sent / chosen.size) * 100) : 0);

  async function loadSystems(): Promise<void> {
    try {
      systems = (await client.systems()).systems;
      if (!system) system = systems[0]?.identifier ?? '';
    } catch (error) {
      failure = explain(error);
    }
  }

  function pick(event: Event): void {
    chosen = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
    sent = 0;
    if (chosen && !title.trim()) title = chosen.name.replace(/\.[^.]+$/, '');
  }

  async function send(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const file = chosen;
    if (!file) return;
    working = true;
    failure = null;
    sent = 0;
    try {
      // An asset belongs to an item, and a server that has never scanned a
      // folder has none, so the first upload has to create one.
      const target =
        item ??
        (await client.createItem({ libraryId, systemIdentifier: system, title: title.trim() }));
      await client.upload({
        libraryId,
        itemId: target.id,
        kind,
        displayName: file.name,
        relativePath: file.name,
        baseRevision: target.revision,
        body: file,
        chunkBytes: CHUNK_BYTES,
        onProgress: (bytesSent) => {
          sent = bytesSent;
        },
      });
      chosen = null;
      title = '';
      // The input keeps showing the file it was given until it is cleared, which
      // would read as an upload still waiting to be sent.
      if (field) field.value = '';
      oncomplete();
    } catch (error) {
      failure = explain(error);
    } finally {
      working = false;
    }
  }

  void loadSystems();
</script>

<section>
  <h2>{item ? `Add a file to ${item.title}` : 'Upload a new item'}</h2>
  <form onsubmit={send}>
    <label>
      File
      <input bind:this={field} type="file" onchange={pick} required />
    </label>
    <label>
      Kind
      <select bind:value={kind}>
        {#each KINDS as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    </label>
    {#if !item}
      <label>
        Title
        <input bind:value={title} placeholder="Game name" required />
      </label>
      <label>
        System
        <select bind:value={system} required>
          {#each systems as entry (entry.identifier)}
            <option value={entry.identifier}>{entry.name}</option>
          {/each}
        </select>
      </label>
    {/if}
    <button type="submit" disabled={working || !chosen}>Upload</button>
  </form>
  {#if chosen && (working || sent > 0)}
    <p class="dim">
      <progress max="100" value={percent}></progress>
      {percent}% of {bytes(chosen.size)}
    </p>
  {/if}
  {#if failure}
    <p class="problem">{failure}</p>
  {/if}
</section>
