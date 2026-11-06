<script lang="ts">
  import type { ServerUpdatesView } from './lib/server-updates';

  let { updates }: { updates: ServerUpdatesView } = $props();
  const status = $derived($updates.status);
  const busy = $derived($updates.working || status?.phase === 'downloading' || status?.phase === 'restarting');
</script>

<h1>Server updates</h1>
{#if status?.supported}
  {#if status.current}<p>Installed build: <strong>{status.current.version}</strong></p>{/if}
  <div class="update-preferences">
    <label>
      Channel
      <select value={status.settings.channel} disabled={busy} onchange={(event) =>
        void updates.configure({ ...status.settings, channel: event.currentTarget.value })}>
        <option value="release">Release</option>
        <option value="nightly">Nightly</option>
      </select>
    </label>
    <label>
      Updates
      <select value={status.settings.mode} disabled={busy} onchange={(event) =>
        void updates.configure({ ...status.settings, mode: event.currentTarget.value })}>
        <option value="off">Off</option>
        <option value="manual">Manual</option>
        <option value="automatic">Automatic</option>
      </select>
    </label>
  </div>
  {#if status.settings.mode === 'off'}
    <p>Update checks are disabled.</p>
  {:else}
    <p>{status.settings.mode === 'automatic'
      ? 'The server checks for updates every hour and restarts briefly to install them.'
      : 'The server checks every hour and asks before installing an update.'}</p>
    {#if status.phase === 'checking'}<p role="status">Checking GitHub…</p>
    {:else if status.phase === 'downloading'}<p role="status">Downloading and verifying the update…</p>
    {:else if status.phase === 'restarting'}<p role="status">Restarting the server…</p>
    {:else if status.available}<p>Available build: <strong>{status.available.version}</strong></p>{/if}
    <div class="update-actions">
      <button type="button" disabled={busy || status.phase === 'checking'} onclick={() => void updates.decide('check')}>
        Check now
      </button>
      {#if status.available && !status.prompt && status.phase === 'idle'}
        <button type="button" disabled={busy} onclick={() => void updates.decide('install', status?.available?.id)}>
          Update now
        </button>
      {/if}
    </div>
  {/if}
  {#if status.message}<p role="status">{status.message}</p>{/if}
  {#if $updates.error}<p class="problem" role="alert">{$updates.error}</p>{/if}
{:else}
  <p>{status?.message ?? 'Update settings are unavailable for this server.'}</p>
{/if}

<style>
  .update-preferences, .update-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  label { display: grid; gap: 0.3rem; }
</style>
