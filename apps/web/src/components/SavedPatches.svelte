<script lang="ts">
  import { ContentError, type ContentClient, type GameCompanion } from '@ecs/client';
  import { onMount } from 'svelte';
  import { bytes } from '../lib/format';
  import { explain } from '../lib/problems';

  let { client, sourceId, onauthorization }: {
    client: ContentClient;
    sourceId: string;
    onauthorization: (status: 401 | 403) => void;
  } = $props();
  const lifetime = new AbortController();
  let patches = $state<GameCompanion[]>([]);
  let downloading = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let needsRefresh = $state(false);

  onMount(() => {
    void load();
    return () => lifetime.abort();
  });

  function handleError(error: unknown, listing = false) {
    if (lifetime.signal.aborted) return;
    if (error instanceof ContentError && (error.status === 401 || error.status === 403)) {
      patches = [];
      onauthorization(error.status);
    }
    if (listing || (error instanceof ContentError && error.status === 404)) {
      patches = [];
      needsRefresh = true;
    }
    failure = explain(error);
  }

  async function load() {
    failure = null;
    needsRefresh = false;
    try {
      const result = await client.sourceCompanions(sourceId, lifetime.signal);
      if (!lifetime.signal.aborted) patches = result.items.filter((file) => file.kind === 'patch');
    } catch (error) {
      handleError(error, true);
    }
  }

  async function download(patch: GameCompanion) {
    if (downloading) return;
    downloading = patch.id;
    failure = null;
    try {
      const result = await client.collectSourcePatch(sourceId, patch, lifetime.signal);
      if (lifetime.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/octet-stream' }));
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = patch.filename;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      handleError(error);
    } finally {
      if (!lifetime.signal.aborted) downloading = null;
    }
  }
</script>

{#if patches.length || failure}
  <section aria-label="Saved patches">
    <h2>Saved patches</h2>
    {#if patches.length}
      <ul>
        {#each patches as patch (patch.id)}
          <li>
            <p><strong>{patch.filename}</strong> · {bytes(patch.sizeBytes)}</p>
            {#if patch.base}
              <p class="dim">Base ROM CRC32 <code>{patch.base.crc32}</code> · {bytes(patch.base.sizeBytes)}</p>
            {:else}
              <p class="dim">This patch does not include a base ROM checksum.</p>
            {/if}
            <button type="button" disabled={!!downloading} onclick={() => void download(patch)}>
              {downloading === patch.id ? 'Verifying patch…' : 'Download patch'}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
    {#if needsRefresh}<button type="button" onclick={() => void load()}>Refresh patches</button>{/if}
  </section>
{/if}
