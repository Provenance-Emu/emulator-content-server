<script lang="ts">
  import { onMount } from 'svelte';
  import type { ContentClient } from '@ecs/client';
  import { explain } from './lib/problems';

  let { client, rootId, sourceId, onconverted = () => {} }: {
    client: ContentClient;
    rootId: string;
    sourceId?: string;
    onconverted?: () => void;
  } = $props();

  let enabled = $state(false);
  let keepOriginals = $state(false);
  let loading = $state(true);
  let working = $state(false);
  let failure = $state('');
  let message = $state('');

  onMount(() => {
    let mounted = true;
    void client.folderDiscConversion(rootId).then(policy => {
      if (!mounted) return;
      enabled = policy.enabled;
      keepOriginals = policy.keepOriginals;
    }).catch(error => {
      if (mounted) failure = explain(error);
    }).finally(() => {
      if (mounted) loading = false;
    });
    return () => { mounted = false; };
  });

  async function apply() {
    working = true;
    failure = '';
    message = '';
    try {
      if (sourceId) {
        const converted = await client.convertSourceDisc(sourceId, { keepOriginals });
        message = `Converted to ${converted.name}.`;
        onconverted();
      } else {
        await client.setFolderDiscConversion(rootId, { enabled, keepOriginals });
        message = enabled ? 'Conversion will run after the next folder scan.' : 'Automatic conversion is off.';
      }
    } catch (error) {
      failure = explain(error);
    } finally {
      working = false;
    }
  }
</script>

<form class="disc-conversion" onsubmit={(event) => { event.preventDefault(); void apply(); }}>
  {#if !sourceId}
    <label><input type="checkbox" bind:checked={enabled} disabled={loading || working} /> Convert supported discs after scans</label>
  {/if}
  <label><input type="checkbox" bind:checked={keepOriginals} disabled={loading || working} /> Keep original disc files</label>
  <small class="dim">
    {keepOriginals
      ? 'Originals move to a hidden .ecs-chd folder next to the new CHD.'
      : 'The verified CHD replaces the original disc files.'}
  </small>
  <div>
    <button type="submit" disabled={loading || working}>
      {working ? (sourceId ? 'Converting…' : 'Saving…') : (sourceId ? 'Convert to CHD' : 'Save conversion settings')}
    </button>
  </div>
  {#if failure}<p role="alert" class="problem">{failure}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
</form>

<style>
  .disc-conversion { display: grid; gap: .65rem; }
</style>
