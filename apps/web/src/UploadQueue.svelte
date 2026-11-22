<script lang="ts">
  import type { ContentClient } from '@ecs/client';
  import ListMore from './components/ListMore.svelte';
  import { shownLabel } from './lib/batches';
  import { bytes } from './lib/format';
  import type { UploadQueue, UploadQueueEntry } from './lib/upload-queue';
  import UploadTargetPicker from './UploadTargetPicker.svelte';
  let {
    controller,
    client,
    libraryId,
    onauthorization = () => {},
  }: {
    controller: UploadQueue;
    client: ContentClient;
    libraryId: string;
    onauthorization?: (status: 401 | 403) => void;
  } = $props();
  let picking = $state<string | null>(null);
  const folderSupported = typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input');
  const successes = $derived($controller.entries.filter((e) => e.state === 'succeeded').length);
  const total = $derived($controller.entries.reduce((sum, e) => sum + e.size, 0));
  const sent = $derived($controller.entries.reduce((sum, e) => sum + (e.state === 'succeeded' ? e.size : e.sent), 0));
  // The queue changes its rows in place, so the lists below read the store directly: a list
  // derived here would hand Svelte the same row objects and it would not draw them again.
  const unfinished = $derived($controller.visible.filter((e) => e.state !== 'succeeded').length);
  const finished = $derived($controller.visible.filter((e) => e.state === 'succeeded').length);
  const STATES: Record<UploadQueueEntry['state'], string> = {
    waiting: 'Waiting',
    uploading: 'Uploading',
    succeeded: 'Uploaded',
    failed: 'Did not finish',
    'reconciliation-required': 'Needs a check',
  };
  const progress = (entry: UploadQueueEntry) =>
    entry.state === 'uploading' || entry.sent > 0
      ? `${STATES[entry.state]} · ${bytes(entry.sent)} of ${bytes(entry.size)}`
      : `${STATES[entry.state]} · ${bytes(entry.size)}`;
</script>

<section aria-label="Upload queue" aria-live="polite" class="upload-queue">
  <header class="queue-head">
    <h3>{successes === $controller.entries.length && $controller.entries.length ? 'Uploaded' : $controller.running ? 'Uploading…' : 'Upload queue'}</h3>
    <p>{successes} succeeded · {$controller.entries.length - successes} unfinished</p>
    <progress aria-label="Overall upload progress" max={total || 1} value={sent}></progress>
  </header>
  {#if $controller.remembering}
    <p class="dim">{$controller.recoverable ? 'Progress is saved on this device for this signed-in session. Reselect the original files after reopening to continue.' : successes === $controller.entries.length ? 'All uploads finished. Saved recovery progress has been cleared.' : 'Progress will be saved after the files are verified.'}</p>
    {#if !$controller.running && $controller.recoverable}<button type="button" disabled={!!$controller.checking} onclick={() => void controller.forgetProgress()}>Forget saved progress</button>{/if}
  {:else if successes !== $controller.entries.length}<p class="dim">Keep this page open. This queue is not saved across reloads.</p>{/if}
  {#if $controller.entries.some((e) => e.state !== 'succeeded' && !e.file)}
    <div class="queue-reselect">
      <p>Choose the original files or folder again. Nothing uploads until their contents match and you choose Retry.</p>
      <label>Reselect files<input type="file" multiple disabled={$controller.running || !!$controller.checking} onchange={(event) => void controller.attachFiles(Array.from(event.currentTarget.files ?? []))} /></label>
      {#if folderSupported}<label>Reselect folder<input type="file" multiple {...{webkitdirectory:true}} disabled={$controller.running || !!$controller.checking} onchange={(event) => void controller.attachFiles(Array.from(event.currentTarget.files ?? []))} /></label>{/if}
    </div>
  {/if}
  {#if $controller.checking}<p role="status">Checking {$controller.checking}…</p><button type="button" disabled={$controller.stopping} onclick={() => controller.stopAfterCurrent()}>Stop checking files</button>{/if}
  {#if $controller.failure}<p class="problem" role="alert">{$controller.failure}</p>{/if}
  {#if $controller.status === 401 || $controller.status === 403}<p role="alert" class="problem">Upload authorization was lost. Sign in or restore access before retrying.</p>{/if}
  <div class="actions">
    {#if $controller.running}<button type="button" disabled={$controller.stopping} onclick={() => controller.stopAfterCurrent()}>Stop after current file</button>
    {:else if $controller.entries.some((e) => (e.state === 'waiting' || e.state === 'failed') && e.file)}<button type="button" class="primary" disabled={!!$controller.checking} onclick={() => void controller.retryUnfinished()}>Retry unfinished uploads</button>{/if}
  </div>
  {#if $controller.stopping && $controller.running}<p class="dim">Stopping after the current file finishes. Its server commit may still complete.</p>{/if}
  {#if picking}
    <UploadTargetPicker
      {client}
      {libraryId}
      heading="Which game was being created?"
      {onauthorization}
      oncancel={() => (picking = null)}
      onchoose={(item) => { if (picking) void controller.reconcile(picking, item); picking = null; }}
    />
  {/if}
  {#if unfinished}
    <ul class="upload-entries" aria-label="Unfinished files">
      {#each $controller.visible.filter((e) => e.state !== 'succeeded') as entry (entry.id)}
        <li class:attention={entry.state === 'failed' || entry.state === 'reconciliation-required'}>
          <div class="entry-main">
            <div class="entry-text">
              <strong>{entry.relativePath}</strong>
              <span class="dim">{progress(entry)}</span>
            </div>
            {#if entry.state === 'reconciliation-required'}
              <button type="button" disabled={$controller.running} onclick={() => (picking = entry.id)}>Choose game for {entry.name}</button>
            {/if}
          </div>
          {#if entry.state === 'uploading' || (entry.sent > 0 && entry.sent < entry.size)}
            <progress aria-label={`Progress for ${entry.name}`} max={entry.size || 1} value={entry.sent}></progress>
          {/if}
          {#if entry.failure}<p class="problem entry-problem">{entry.failure}</p>{/if}
          {#if entry.state === 'failed'}<p class="dim entry-problem">Retry uses the same item, file, and transfer key, so nothing is uploaded twice.</p>{/if}
          {#if entry.state === 'reconciliation-required'}<p class="entry-problem" role="alert">This upload stopped while its game was being created, so the server may already have it. Choose that game if it is listed, then retry.</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if finished}
    <details class="queue-done" open={finished <= 12}>
      <summary>{finished.toLocaleString()} uploaded</summary>
      <ul class="upload-entries" aria-label="Uploaded files">
        {#each $controller.visible.filter((e) => e.state === 'succeeded') as entry (entry.id)}
          <li>
            <div class="entry-text">
              <strong>{entry.relativePath}</strong>
              <span class="dim">{STATES.succeeded} · {bytes(entry.size)}</span>
            </div>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
  {#if $controller.entries.length > $controller.visible.length || $controller.visible.length > 50}<ListMore
      label={shownLabel($controller.visible.length, $controller.hasMore, ['file', 'files'], $controller.entries.length)}
      more={$controller.hasMore}
      action="Show more files"
      onmore={() => controller.more()}
    />{/if}
</section>

<style>
  .upload-queue {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
  }
  .upload-queue p {
    margin: 0;
  }
  .queue-head {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: baseline;
    gap: var(--space-1) var(--space-4);
  }
  .queue-head h3 {
    margin: 0;
  }
  .queue-head p {
    color: var(--color-text-muted);
    font-size: var(--text-small);
    font-variant-numeric: tabular-nums;
  }
  .queue-head progress {
    grid-column: 1 / -1;
  }
  progress {
    display: block;
    width: 100%;
  }
  .queue-reselect {
    display: grid;
    gap: var(--space-2);
  }
  .upload-entries {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .upload-entries li {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-3) 0;
    border-top: var(--border-width) solid var(--color-border);
    overflow-wrap: anywhere;
  }
  .upload-entries li.attention {
    padding-inline-start: var(--space-3);
    border-inline-start: 3px solid var(--color-warning);
  }
  .entry-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .entry-text {
    display: grid;
    min-width: 0;
  }
  .entry-text .dim,
  .entry-problem {
    font-size: var(--text-small);
  }
  .queue-done summary {
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: var(--text-small);
  }
</style>
