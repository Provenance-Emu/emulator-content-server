<script lang="ts">
  import { buildName, type ServerUpdatesView } from './lib/server-updates';

  let { updates }: { updates: ServerUpdatesView } = $props();
  const status = $derived($updates.status);
  const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value));
  const busy = $derived($updates.working || status?.phase === 'downloading' || status?.phase === 'restarting');
</script>

<section>
<h2>Server updates</h2>
{#if status?.supported}
  <dl class="update-dates">
    {#if status.current}
      <dt>Installed version</dt><dd title={status.current.version}>{buildName(status.current)}</dd>
      {#if status.current.builtAt}<dt>Built</dt><dd><time datetime={status.current.builtAt}>{formatDate(status.current.builtAt)}</time></dd>{/if}
    {/if}
    <dt>Last checked</dt><dd>{#if status.lastCheckedAt}<time datetime={status.lastCheckedAt}>{formatDate(status.lastCheckedAt)}</time>{:else}No check recorded{/if}</dd>
  </dl>
  {#if status.available && status.settings.mode !== 'off'}
    <p role="status"><strong>Update available</strong> · {buildName(status.available)}
    </p>
  {/if}
  <div class="update-preferences">
    <label>
      Which versions
      <select value={status.settings.channel} disabled={busy} onchange={(event) =>
        void updates.configure({ ...status.settings, channel: event.currentTarget.value })}>
        <option value="release">Stable releases</option>
        <option value="nightly">Nightly builds (newest, less tested)</option>
      </select>
    </label>
    <label>
      Installing updates
      <select value={status.settings.mode} disabled={busy} onchange={(event) =>
        void updates.configure({ ...status.settings, mode: event.currentTarget.value })}>
        <option value="off">Off</option>
        <option value="manual">Ask me first</option>
        <option value="automatic">Install automatically</option>
      </select>
    </label>
  </div>
  {#if status.settings.mode === 'off'}
    <p>This server does not look for updates.</p>
  {:else}
    <p>{status.settings.mode === 'automatic'
      ? 'The server checks for updates every hour and restarts briefly to install them.'
      : 'The server checks every hour and asks before installing an update.'}</p>
    {#if status.phase === 'checking'}<p role="status">Checking for updates…</p>
    {:else if status.phase === 'downloading'}<p role="status">Downloading the update…</p>
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
        <li data-version={entry.build.version} title={entry.build.version}><strong>{buildName(entry.build)}</strong> · {entry.outcome === 'installed' ? 'Installed' : entry.outcome === 'rolled-back' ? 'Went back to this version after a failed update' : 'Already installed when updates were turned on'} · <time datetime={entry.at}>{formatDate(entry.at)}</time></li>
      {/each}
    </ul>
  {:else}<p>No updates have been installed yet.</p>{/if}
  {#if status.message}<p role="status">{status.message}</p>{/if}
  {#if $updates.error}<p class="problem" role="alert">{$updates.error}</p>{/if}
{:else}
  <p>{'This server does not update itself. Install a newer version the same way this one was installed.'}</p>
{/if}

</section>

<style>
  .update-preferences, .update-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .update-dates { display: grid; grid-template-columns: max-content 1fr; gap: .4rem 1rem; }
  .update-dates dd { margin: 0; }
  .update-history { padding-inline-start: 1.2rem; }
  label { display: grid; gap: 0.3rem; }
</style>
