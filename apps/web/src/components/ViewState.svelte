<script lang="ts">
  let {
    loading = false,
    failure = null,
    empty = false,
    filtered = false,
  }: {
    loading?: boolean;
    failure?: string | null;
    empty?: boolean;
    filtered?: boolean;
  } = $props();
</script>

{#if failure}<p class="problem" role="alert">{failure}</p>{/if}
{#if loading}<p class="dim" role="status">Reading collection…</p>
{:else if empty && !failure}<div class="empty-state">
    <h3>
      {filtered ? 'No matching files or games.' : 'This collection is empty.'}
    </h3>
    <p class="dim">
      {filtered
        ? 'Try another search or clear the filters.'
        : 'Files appear here after an upload or an explicit library-folder scan.'}
    </p>
  </div>{/if}
