<script lang="ts">
  import type { ServerUpdatesView } from './lib/server-updates';

  let { updates }: { updates: ServerUpdatesView } = $props();
  const status = $derived($updates.status);
  const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value));
  const busy = $derived($updates.working || status?.phase === 'downloading' || status?.phase === 'restarting');
</script>

<h2>Server updates</h2>
{#if status?.supported}
  <dl class="update-dates">
    {#if status.current}
      <dt>Installed build</dt><dd>{status.current.version}</dd>
      {#if status.current.builtAt}<dt>Built</dt><dd><time datetime={status.current.builtAt}>{formatDate(status.current.builtAt)}</time></dd>{/if}
    {/if}
    <dt>Last checked</dt><dd>{#if status.lastCheckedAt}<time datetime={status.lastCheckedAt}>{formatDate(status.lastCheckedAt)}</time>{:else}No check recorded{/if}</dd>
  </dl>
  {#if status.available && status.settings.mode !== 'off'}
    <p role="status"><strong>Update available</strong> · {status.available.version}
      {#if status.available.builtAt} · <time datetime={status.available.builtAt}>{formatDate(status.available.builtAt)}</time>{/if}
    </p>
  {/if}
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
    {/if}
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
  <h3>Update history</h3>
  {#if status.history?.length}
    <ul class="update-history">
      {#each status.history as entry}
        <li><strong>{entry.build.version}</strong> · {entry.outcome === 'installed' ? 'Installed' : entry.outcome === 'rolled-back' ? 'Rolled back' : 'First observed'} · <time datetime={entry.at}>{formatDate(entry.at)}</time></li>
      {/each}
    </ul>
  {:else}<p>No installation history recorded yet.</p>{/if}
  {#if status.message}<p role="status">{status.message}</p>{/if}
  {#if $updates.error}<p class="problem" role="alert">{$updates.error}</p>{/if}
{:else}
  <p>{status?.message ?? 'Update settings are unavailable for this server.'}</p>
{/if}

<style>
  .update-preferences, .update-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .update-dates { display: grid; grid-template-columns: max-content 1fr; gap: .4rem 1rem; }
  .update-dates dd { margin: 0; }
  .update-history { padding-inline-start: 1.2rem; }
  label { display: grid; gap: 0.3rem; }
</style>
