<script lang="ts">
  import { ContentError, type ContentClient, type Item, type SystemSummary } from '@ecs/client';
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
  let target = $state<Item | null>(null);
  let transferKey: string | null = null;
  let creationUncertain = $state(false);
  const locked = $derived(working || target !== null || creationUncertain);

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

  function resetAttempt(): void {
    chosen = null;
    target = null;
    transferKey = null;
    title = '';
    sent = 0;
    failure = null;
    if (field) field.value = '';
  }

  async function send(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const file = chosen;
    if (!file || working || creationUncertain || (!item && (!system || kind !== 'rom'))) return;
    working = true;
    onbusy(true);
    failure = null;
    sent = 0;
    try {
      // An asset belongs to an item, and a server that has never scanned a
      // folder has none, so the first upload has to create one.
      if (!target) {
        try {
          target = item ?? await client.createItem({
            libraryId,
            systemIdentifier: system,
            title: title.trim(),
          });
        } catch (error) {
          // Item creation has no idempotency contract. Never blindly repeat an
          // uncertain creation; the operator can recover through the existing game.
          if (!disposed && (!(error instanceof ContentError) || error.status >= 500))
            creationUncertain = true;
          throw error;
        }
      }
      if (disposed) return;
      // getRandomValues also works on ordinary LAN HTTP, unlike randomUUID.
      transferKey ??= `browser-upload-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      await client.upload({
        libraryId,
        itemId: target.id,
        kind,
        displayName: file.name,
        relativePath: file.name,
        baseRevision: target.revision,
        body: file,
        idempotencyKey: transferKey,
        chunkBytes: CHUNK_BYTES,
        onProgress: (bytesSent) => {
          if (!disposed) sent = bytesSent;
        },
      });
      if (disposed) return;
      // The input keeps showing the file it was given until it is cleared, which
      // would read as an upload still waiting to be sent.
      resetAttempt();
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
      <input bind:this={field} type="file" onchange={pick} disabled={locked} required />
    </label>
    <label>
      Kind
      <select bind:value={kind} disabled={locked}>
        {#each item ? KINDS : ['rom'] as option (option)}
          <option value={option}>{kindLabel(option)}</option>
        {/each}
      </select>
    </label>
    {#if !item}
      <label>
        Title
        <input bind:value={title} placeholder="Game name" disabled={locked} required />
      </label>
      <label>
        System
        <select bind:value={system} disabled={locked} required>
          <option value="" disabled>Choose a system</option>
          {#each systems as entry (entry.identifier)}
            <option value={entry.identifier}>{entry.name}</option>
          {/each}
        </select>
      </label>
    {/if}
    <button type="submit" disabled={working || creationUncertain || !chosen || (!item && !system)}>Upload</button>
  </form>
  {#if target && !working && failure}
    <p class="dim">Retry uses the same game and file. Choosing another file keeps this game in your library.</p>
    <button type="button" onclick={resetAttempt}>Choose another file</button>
  {/if}
  {#if creationUncertain}<p class="problem" role="alert">The server may have created this game. Close this upload and refresh the library, then open that game and choose Add a file.</p>{/if}
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
