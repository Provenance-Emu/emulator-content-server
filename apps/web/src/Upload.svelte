<script lang="ts">
  import type { ContentClient, Item, SystemSummary } from '@ecs/client';
  import { onDestroy } from 'svelte';
  import { kindLabel } from './lib/content-format';
  import { bytes } from './lib/format';
  import { explain } from './lib/problems';

  let {
    client,
    libraryId,
    item,
    oncomplete,
    onbusy = () => {},
  }: {
    client: ContentClient;
    libraryId: string;
    /** The item to add a file to, or null to create one from this upload. */
    item: Item | null;
    oncomplete: () => void;
    onbusy?: (busy: boolean) => void;
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

  let disposed = false;
  onDestroy(() => {
    disposed = true;
  });

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
      const result = await client.systems();
      if (!disposed) systems = result.systems;
    } catch (error) {
      if (!disposed) failure = explain(error);
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
    if (!file || working || (!item && (!system || kind !== 'rom'))) return;
    working = true;
    onbusy(true);
    failure = null;
    sent = 0;
    try {
      // An asset belongs to an item, and a server that has never scanned a
      // folder has none, so the first upload has to create one.
      const target =
        item ??
        (await client.createItem({
          libraryId,
          systemIdentifier: system,
          title: title.trim(),
        }));
      if (disposed) return;
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
          if (!disposed) sent = bytesSent;
        },
      });
      if (disposed) return;
      chosen = null;
      title = '';
      // The input keeps showing the file it was given until it is cleared, which
      // would read as an upload still waiting to be sent.
      if (field) field.value = '';
      oncomplete();
    } catch (error) {
      if (!disposed) failure = explain(error);
    } finally {
      if (!disposed) {
        working = false;
        onbusy(false);
      }
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
        {#each item ? KINDS : ['rom'] as option (option)}
          <option value={option}>{kindLabel(option)}</option>
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
          <option value="" disabled>Choose a system</option>
          {#each systems as entry (entry.identifier)}
            <option value={entry.identifier}>{entry.name}</option>
          {/each}
        </select>
      </label>
    {/if}
    <button type="submit" disabled={working || !chosen || (!item && !system)}>Upload</button>
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
