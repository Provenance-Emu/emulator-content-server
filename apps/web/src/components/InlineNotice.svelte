<script lang="ts">
  import type { Snippet } from 'svelte';

  let { kind = 'info', children }: {
    kind?: 'info' | 'status' | 'error';
    children: Snippet;
  } = $props();
</script>

<p class="inline-notice" class:notice-error={kind === 'error'} class:notice-status={kind === 'status'}
  role={kind === 'error' ? 'alert' : kind === 'status' ? 'status' : undefined}
  aria-atomic={kind === 'info' ? undefined : true}>{@render children()}</p>
