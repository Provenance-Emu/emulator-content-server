<script lang="ts">
  import type { Snippet } from 'svelte';

  const generatedId = $props.id();
  let { label, help = null, id = generatedId, children }: {
    label: string;
    help?: string | null;
    id?: string;
    children: Snippet<[{ id: string; 'aria-describedby': string | undefined }]>;
  } = $props();
  const attributes = $derived({ id, 'aria-describedby': help ? `${id}-help` : undefined });
</script>

<div class="form-field">
  <label for={id}>{label}</label>
  {@render children(attributes)}
  {#if help}<p class="form-help" id={`${id}-help`}>{help}</p>{/if}
</div>
