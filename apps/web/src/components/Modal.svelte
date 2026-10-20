<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  let {
    title,
    onclose,
    busy = false,
    children,
    navigation = false,
  }: {
    title: string;
    onclose: () => void;
    busy?: boolean;
    children: Snippet;
    navigation?: boolean;
  } = $props();
  let dialog: HTMLDialogElement;
  onMount(() => {
    dialog.showModal();
    return () => {
      dialog.close();
    };
  });
</script>

<dialog
  bind:this={dialog}
  aria-label={title}
  class:navigation-dialog={navigation}
  {onclose}
  oncancel={(event) => {
    if (busy) event.preventDefault();
  }}
>
  <div class="dialog-heading">
    <h2>{title}</h2>
    <button
      type="button"
      aria-label={`Close ${title}`}
      disabled={busy}
      onclick={() => dialog.close()}
    >
      Close
    </button>
  </div>
  {@render children()}
</dialog>
