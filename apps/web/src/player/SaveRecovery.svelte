<script lang="ts">
  import { explain } from '../lib/problems';
  import { downloadBytes } from './downloads.js';
  import type { SaveSynchronizer } from './saves.js';

  let { saves, refresh = 0, disabled = false, onbusy = () => {}, onchange = () => {} }: {
    saves: SaveSynchronizer;
    refresh?: number;
    disabled?: boolean;
    onbusy?: (busy: boolean) => void;
    onchange?: () => void;
  } = $props();
  let working = $state(false);
  let revision = $state(0);
  let failure = $state<string | null>(null);
  let message = $state('');
  const pending = $derived.by(() => { refresh; revision; return saves.pending; });

  async function retry() {
    if (working || disabled) return;
    working = true;
    failure = null;
    message = '';
    onbusy(true);
    try {
      await saves.retry();
      message = saves.previewWarning ?? 'Upload saved.';
      if (saves.lastConflict) message = `Kept both saves. Browser copy saved as ${saves.lastConflict.relativePath}.`;
    } catch (error) {
      failure = explain(error);
    } finally {
      revision++;
      working = false;
      onbusy(false);
      onchange();
    }
  }

  function exportPending() {
    if (!pending) return;
    downloadBytes(saves.exportPending(), pending.relativePath,
      pending.kind === 'screenshot' ? 'image/png' : 'application/octet-stream');
  }

  function dismissImage() {
    saves.dismissPendingImage();
    revision++;
    failure = null;
    message = saves.previewWarning ?? 'Pending image dismissed.';
    onchange();
  }
</script>

{#if pending || failure || message}
  <section class="save-recovery" aria-label="Save upload recovery">
    {#if pending}
      <h2>{pending.preview ? 'State saved, preview needs attention' : 'Upload needs attention'}</h2>
      <p>{pending.preview ? 'The state is already saved.' : 'Your captured bytes stay available while this page is open.'} Retry the upload or download a copy before leaving.</p>
      <div class="player-controls">
        <button type="button" disabled={working || disabled || !pending.canRetry} onclick={retry}>Retry upload</button>
        <button type="button" onclick={exportPending}>{pending.kind === 'screenshot' ? 'Download pending image' : 'Export captured save'}</button>
        {#if pending.kind === 'screenshot'}<button type="button" disabled={working || disabled} onclick={dismissImage}>{pending.preview ? 'Keep state without preview' : 'Dismiss pending screenshot'}</button>{/if}
      </div>
      <details class="player-technical-details"><summary>Upload details</summary><p class="path">{pending.relativePath} · {pending.size} bytes</p></details>
    {/if}
    {#if message}<p role="status">{message}</p>{/if}
    {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
  </section>
{/if}
