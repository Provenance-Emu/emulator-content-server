<script lang="ts">
  import type { ContentClient } from '@ecs/client';
  import { onDestroy, onMount, untrack } from 'svelte';
  import InlineNotice from './components/InlineNotice.svelte';
  import { bytes } from './lib/format';
  import { createTrash, timeLeft } from './lib/trash';

  let {
    client,
    retentionDays = null,
    onchanged = () => {},
    onrejected = () => {},
  }: {
    client: ContentClient;
    retentionDays?: number | null;
    onchanged?: () => void;
    onrejected?: (status: 401 | 403) => void;
  } = $props();
  const trash = untrack(() => createTrash(client, () => onchanged(), (status) => onrejected(status)));
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  onMount(() => {
    void trash.load();
  });
  onDestroy(() => trash.dispose());
</script>

<h1>Trash</h1>
<section aria-labelledby="trash-heading" class="trash-panel">
  <div class="row">
    <h2 id="trash-heading">Deleted games and files</h2>
    <button type="button" disabled={$trash.loading} onclick={() => void trash.load()}>Refresh</button>
  </div>
  <p class="dim">
    {#if retentionDays}Deleted games and files are kept for {retentionDays} days, then removed for good.{:else}Deleted
      games and files are kept for a while, then removed for good.{/if}
    Games in your server folders are never deleted from disk and do not appear here.
  </p>
  {#if $trash.failure}<InlineNotice kind="error">{$trash.failure}</InlineNotice>{/if}
  {#if $trash.notice}<InlineNotice kind="status">{$trash.notice}</InlineNotice>{/if}
  {#if !$trash.loaded && $trash.loading}<InlineNotice kind="status">Loading…</InlineNotice>
  {:else if $trash.loaded && !$trash.entries.length}<p class="dim">Nothing in the trash.</p>
  {:else if $trash.entries.length}
    <ul class="trash-list" aria-label="Trash">
      {#each $trash.entries as entry (entry.id)}
        <li>
          <div class="trash-entry">
            <p class="trash-line trash-name">{entry.name}</p>
            <p class="trash-line trash-detail dim">
              {entry.kind === 'item' ? 'Game' : `File in ${entry.itemTitle}`}
              · {entry.kind === 'item' && entry.fileCount !== 1 ? `${entry.fileCount} files, ` : ''}{bytes(entry.size)}
            </p>
            <p class="trash-line trash-detail dim">
              Deleted {when.format(new Date(entry.deletedAt))}{#if entry.deletedBy?.name} by {entry.deletedBy.name}{/if}
              · {timeLeft(entry.purgeAfter)}
            </p>
            {#if entry.itemDeleted}<p class="trash-line trash-detail dim">Restore {entry.itemTitle} first to bring this file back.</p>{/if}
          </div>
          <button
            type="button"
            aria-label={`Restore ${entry.name}`}
            disabled={!!$trash.restoring || entry.itemDeleted}
            onclick={() => void trash.restore(entry)}
          >{$trash.restoring === entry.id ? 'Restoring…' : 'Restore'}</button>
        </li>
      {/each}
    </ul>
    {#if $trash.more}<button type="button" disabled={$trash.loading} onclick={() => void trash.loadMore()}>
        {$trash.loading ? 'Loading…' : 'Show more'}
      </button>{/if}
  {/if}
</section>
