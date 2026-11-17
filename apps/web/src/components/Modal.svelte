<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import Icon from './Icon.svelte';
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
  let disposed = false;
  onMount(() => {
    dialog.showModal();
    return () => {
      disposed = true;
      dialog.close();
    };
  });
</script>

<dialog
  bind:this={dialog}
  aria-label={title}
  class:navigation-dialog={navigation}
  onclose={() => { if (!disposed) onclose(); }}
  oncancel={(event) => {
    if (busy) event.preventDefault();
  }}
>
  <div class="dialog-heading">
    <h2>{title}</h2>
    <button
      type="button"
      class="dialog-close"
      aria-label={`Close ${title}`}
      disabled={busy}
      onclick={() => dialog.close()}
    >
      <Icon name="close" />
    </button>
  </div>
  {@render children()}
</dialog>
