<script lang="ts">
  import type { ServerUpdatesView } from './lib/server-updates';

  let { updates }: { updates: ServerUpdatesView } = $props();
  const status = $derived($updates.status);
</script>

{#if status?.prompt && status.available}
  {@const id = status.available.id}
  <section aria-label="Server update available" class="update-prompt">
    <p>A server update is available. <strong>{status.available.version}</strong></p>
    <div>
      <button class="primary" type="button" disabled={$updates.working} onclick={() => void updates.decide('install', id)}>Update now</button>
      <button type="button" disabled={$updates.working} onclick={() => void updates.decide('later', id)}>Later</button>
      <button type="button" disabled={$updates.working} onclick={() => void updates.decide('skip', id)}>Skip this version</button>
    </div>
    {#if $updates.error || status.message}<p class="problem" role="alert">{$updates.error ?? status.message}</p>{/if}
  </section>
{:else if status?.phase === 'downloading' || status?.phase === 'restarting'}
  <p role="status" class="update-prompt">{status.phase === 'downloading'
    ? 'Downloading and verifying the server update…'
    : 'Restarting the server…'}</p>
{/if}

<style>
  .update-prompt { padding: 0.75rem 1rem; margin-block-end: 1rem; border: 1px solid currentColor; border-radius: 0.5rem; }
  .update-prompt p:first-child { margin-top: 0; }
  .update-prompt div { display: flex; flex-wrap: wrap; gap: 0.5rem; }
</style>
