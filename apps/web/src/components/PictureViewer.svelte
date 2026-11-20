<script lang="ts" module>
  export interface Picture {
    key: string;
    label: string;
    alt: string;
    /** Null while it loads, or when the file is not something a browser can show. */
    url: string | null;
    pending?: boolean;
    /** Shown in place of a picture that cannot be displayed. */
    note?: string;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';
  let {
    title,
    pictures,
    viewing = $bindable(null),
    busy = false,
    caption,
    tools,
    footer,
    onstep = () => {},
  }: {
    title: string;
    pictures: Picture[];
    /** Key of the picture on show; null closes the viewer. */
    viewing?: string | null;
    busy?: boolean;
    caption: Snippet<[Picture]>;
    /** Icon buttons for the picture on show. Each needs an aria-label and a title. */
    tools: Snippet<[Picture]>;
    footer?: Snippet;
    onstep?: () => void;
  } = $props();
  const current = $derived(pictures.find((picture) => picture.key === viewing));
  $effect(() => {
    // The picture on show was removed: move to another, or close.
    if (viewing && !current) viewing = pictures[0]?.key ?? null;
  });
  function show(key: string) {
    viewing = key;
    onstep();
  }
  function step(delta: number) {
    const index = pictures.findIndex((picture) => picture.key === viewing);
    const next = pictures[(index + delta + pictures.length) % pictures.length];
    if (next) show(next.key);
  }
  function keys(event: KeyboardEvent) {
    if (!current || pictures.length < 2) return;
    if (event.key === 'ArrowLeft') step(-1);
    else if (event.key === 'ArrowRight') step(1);
  }
</script>

<svelte:window onkeydown={keys} />

{#if current}
  <Modal {title} {busy} onclose={() => (viewing = null)}>
    <div class="art-viewer">
      <div class="art-stage">
        {#if pictures.length > 1}<button
            type="button"
            class="art-step"
            aria-label="Previous picture"
            onclick={() => step(-1)}
          ><Icon name="back" /></button>{/if}
        <figure>
          {#if current.url}<img src={current.url} alt={current.alt} />
          {:else if current.pending}<p class="dim" role="status">Loading picture…</p>
          {:else}<p class="dim">{current.note ?? 'This file cannot be shown here. Download it to open it.'}</p>{/if}
        </figure>
        {#if pictures.length > 1}<button
            type="button"
            class="art-step"
            aria-label="Next picture"
            onclick={() => step(1)}
          ><Icon name="forward" /></button>{/if}
      </div>
      <div class="art-bar">
        <p>{@render caption(current)}</p>
        <div class="art-tools">{@render tools(current)}</div>
      </div>
      {@render footer?.()}
      {#if pictures.length > 1}
        <div class="art-rail" role="group" aria-label="Pictures of this game">
          {#each pictures as picture (picture.key)}
            <button
              type="button"
              aria-label={picture.label}
              aria-pressed={picture.key === viewing}
              onclick={() => show(picture.key)}
            >
              {#if picture.url}<img src={picture.url} alt="" />{:else}<span>{picture.label}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </Modal>
{/if}

<style>
  .art-viewer {
    display: grid;
    gap: var(--space-3);
    width: min(56rem, 100%);
  }
  .art-stage {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-2);
  }
  .art-stage figure {
    display: grid;
    grid-column: 2;
    place-items: center;
    min-height: 12rem;
    margin: 0;
    border-radius: var(--radius-control);
    background: var(--color-surface-inset);
  }
  .art-stage img {
    max-width: 100%;
    max-height: min(62vh, 40rem);
    object-fit: contain;
  }
  .art-step,
  .art-tools :global(.icon-button) {
    display: grid;
    place-items: center;
    width: var(--control-height-touch);
    min-width: 0;
    padding: 0;
  }
  .art-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .art-bar p {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .art-tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .art-rail {
    display: flex;
    gap: var(--space-2);
    overflow-x: auto;
  }
  .art-rail button {
    flex: 0 0 3.5rem;
    height: 3.5rem;
    min-height: 0;
    padding: 0;
    overflow: hidden;
    font-size: var(--text-small);
  }
  .art-rail button[aria-pressed='true'] {
    border-color: var(--color-selected-border);
    background: var(--color-selected);
  }
  .art-rail img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
