<script lang="ts">
  let {
    loading = false,
    failure = null,
    empty = false,
    filtered = false,
    canAdd = true,
    unassigned = false,
  }: {
    loading?: boolean;
    failure?: string | null;
    empty?: boolean;
    filtered?: boolean;
    canAdd?: boolean;
    /** The owner's view of folders not yet linked to a library. */
    unassigned?: boolean;
  } = $props();
</script>

{#if failure}<p class="problem" role="alert">{failure}</p>{/if}
{#if loading}<p class="collection-loading dim" role="status">Loading your collection…</p>
{:else if empty && !failure}<div class="empty-state">
    <h3>
      {filtered ? 'No matching files or games.' : 'This collection is empty.'}
    </h3>
    <p class="dim">
      {filtered
        ? 'Try another search or clear the filters.'
        : unassigned ? 'Every folder on this server belongs to a library. A folder you add without choosing a library appears here until you assign it.'
        : !canAdd ? 'There are no files here yet. The person who manages this library can add them.'
        : 'Add game files from your device, or choose a folder already on the computer running Emulation Server. Your games will appear here.'}
    </p>
  </div>{/if}
