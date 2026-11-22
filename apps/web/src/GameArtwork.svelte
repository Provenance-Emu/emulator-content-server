<script lang="ts">
  import { type ContentClient, ContentError } from '@ecs/client';
  import Icon from './components/Icon.svelte';
  import PictureViewer from './components/PictureViewer.svelte';
  import type { MatchingController } from './lib/matching';
  import { artworkRoles, roleOf } from './lib/matching-slots';
  import { explain } from './lib/problems';
  let {
    client,
    sourceId,
    matching,
    name,
    canEdit,
    onchanged,
  }: {
    client: ContentClient;
    sourceId: string;
    matching: MatchingController;
    name: string;
    canEdit: boolean;
    onchanged: () => void;
  } = $props();
  const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  const MEGABYTE = 1024 * 1024;
  let viewing = $state<string | null>(null);
  let confirming = $state(false);
  let notice = $state<string | null>(null);
  let picker = $state<HTMLInputElement>();
  let target = 'front';
  const saved = $derived(
    new Map(
      ($matching.saved?.matches ?? [])
        .filter((match) => match.kind === 'artwork')
        .map((match) => [roleOf(match), match]),
    ),
  );
  /** Someone browsing sees the pictures there are; someone who may edit also sees what is missing. */
  const slots = $derived(
    artworkRoles
      .map(([role, label]) => {
        const match = saved.get(role);
        return {
          role,
          label,
          match,
          url: (role === 'front' ? $matching.savedArtwork : $matching.savedArtworkByRole[role]) ?? null,
          image: !!match?.contentAvailable && (match.contentType?.startsWith('image/') ?? false),
        };
      })
      .filter((slot) => slot.match || canEdit),
  );
  const filled = $derived(slots.filter((slot) => slot.match));
  const busy = $derived(
    !!$matching.saving || $matching.savedLoading || $matching.savedLoadFailed || !$matching.saved,
  );
  // Each saved picture is asked for once; a failed read is not retried by the next store update.
  const asked = new Set<string>();
  $effect(() => {
    for (const slot of slots) {
      if (slot.role === 'front' || !slot.image || slot.url || !slot.match) continue;
      const key = `${slot.role}:${slot.match.id}`;
      if (asked.has(key)) continue;
      asked.add(key);
      void matching.previewSaved(slot.role);
    }
  });
  /** Opens the viewer on a saved picture, or the file chooser for one that is missing. */
  export function open(role = 'front') {
    if (saved.has(role)) {
      viewing = role;
      confirming = false;
    } else if (canEdit) choose(role);
  }
  function choose(role: string) {
    if (busy || !picker) return;
    target = role;
    notice = null;
    picker.value = '';
    picker.click();
  }
  async function picked() {
    const file = picker?.files?.[0];
    if (!file) return;
    if (!TYPES.includes(file.type)) {
      notice = 'Choose a PNG, JPEG or WebP picture.';
      return;
    }
    const limit = target === 'manual' ? 8 : 2;
    if (file.size > limit * MEGABYTE) {
      notice = `That picture is larger than ${limit} MB. Choose a smaller one.`;
      return;
    }
    if (await matching.saveArtwork(target, file)) onchanged();
  }
  async function remove(role: string) {
    confirming = false;
    if (await matching.remove(`artwork:${role}`)) onchanged();
  }
  async function download(role: string, fileName: string | null) {
    notice = null;
    try {
      const blob = await client.selectedMatchContent(sourceId, 'artwork', undefined, role);
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName ?? role;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      if (error instanceof ContentError && [401, 403].includes(error.status)) matching.invalidate();
      notice = explain(error);
    }
  }
</script>

{#if slots.length}
  <section class="game-artwork" aria-label="Artwork">
    <h2>Artwork</h2>
    <ul class="art-strip">
      {#each slots as slot (slot.role)}
        <li class:wide={slot.role === 'banner'}>
          {#if slot.match}
            <button
              type="button"
              class="art-tile"
              aria-label={`View ${slot.label.toLowerCase()}`}
              onclick={() => open(slot.role)}
            >
              {#if slot.url}<img src={slot.url} alt="" decoding="async" />
              {:else if slot.image}<span class="dim">Loading…</span>
              {:else}<span class="art-document">Document</span>{/if}
            </button>
            {#if canEdit}<button
                type="button"
                class="art-replace"
                aria-label={`Replace ${slot.label.toLowerCase()}`}
                title="Replace"
                disabled={busy}
                onclick={() => choose(slot.role)}
              ><Icon name="edit" /></button>{/if}
          {:else}
            <button
              type="button"
              class="art-tile empty"
              aria-label={`Add ${slot.label.toLowerCase()}`}
              title={`Add ${slot.label.toLowerCase()}`}
              disabled={busy}
              onclick={() => choose(slot.role)}
            ><Icon name="plus" /></button>
          {/if}
          <span class="art-label">{slot.label}</span>
        </li>
      {/each}
    </ul>
    {#if $matching.saving?.startsWith('artwork:')}<p role="status">Saving picture…</p>{/if}
    {#if notice}<p class="problem" role="alert">{notice}</p>{/if}
    <input
      bind:this={picker}
      class="visually-hidden"
      type="file"
      accept={TYPES.join(',')}
      tabindex="-1"
      aria-label="Choose a picture"
      onchange={() => void picked()}
    />
  </section>
{/if}

<PictureViewer
  title={`Artwork for ${name}`}
  pictures={filled.map((slot) => ({
    key: slot.role,
    label: slot.label,
    alt: `${slot.label} for ${name}`,
    url: slot.url,
    pending: slot.image && !slot.url,
    note: 'This is a document, not a picture. Download it to read it.',
  }))}
  bind:viewing
  busy={!!$matching.saving}
  onstep={() => (confirming = false)}
>
  {#snippet caption(picture)}
    <strong>{picture.label}</strong>
    <span class="dim">{saved.get(picture.key)?.providerId === 'manual' ? 'Added by hand' : 'From a lookup'}</span>
  {/snippet}
  {#snippet tools(picture)}
    {#if confirming}
      <span>Remove this picture?</span>
      <button type="button" disabled={busy} onclick={() => void remove(picture.key)}>Remove</button>
      <button type="button" onclick={() => (confirming = false)}>Keep</button>
    {:else}
      <button
        type="button"
        class="icon-button"
        aria-label={`Download ${picture.label.toLowerCase()}`}
        title="Download"
        onclick={() => void download(picture.key, saved.get(picture.key)?.fileName ?? null)}
      ><Icon name="download" /></button>
      {#if canEdit}
        <button
          type="button"
          class="icon-button"
          aria-label={`Replace ${picture.label.toLowerCase()}`}
          title="Replace"
          disabled={busy}
          onclick={() => choose(picture.key)}
        ><Icon name="upload" /></button>
        <button
          type="button"
          class="icon-button"
          aria-label={`Remove ${picture.label.toLowerCase()}`}
          title="Remove"
          disabled={busy}
          onclick={() => (confirming = true)}
        ><Icon name="trash" /></button>
      {/if}
    {/if}
  {/snippet}
  {#snippet footer()}
    {#if notice}<p class="problem" role="alert">{notice}</p>{/if}
  {/snippet}
</PictureViewer>

<style>
  .art-strip {
    display: flex;
    gap: var(--space-3);
    margin: 0;
    padding: 0 0 var(--space-1);
    overflow-x: auto;
    list-style: none;
  }
  .art-strip li {
    position: relative;
    display: grid;
    flex: 0 0 6.5rem;
    gap: var(--space-1);
    justify-items: center;
  }
  .art-strip li.wide {
    flex-basis: 13rem;
  }
  .art-tile {
    display: grid;
    place-items: center;
    width: 100%;
    height: 6.5rem;
    min-height: 0;
    padding: 0;
    overflow: hidden;
    border-radius: var(--radius-control);
    background: var(--color-surface-inset);
    box-shadow: none;
    font-size: var(--text-small);
  }
  .art-tile img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .art-tile.empty {
    border-style: dashed;
    background: transparent;
    color: var(--color-text-muted);
  }
  .art-label {
    color: var(--color-text-muted);
    font-size: var(--text-small);
    text-align: center;
  }
  .art-replace {
    position: absolute;
    top: var(--space-1);
    right: var(--space-1);
    display: grid;
    place-items: center;
    width: 1.75rem;
    min-width: 0;
    height: 1.75rem;
    min-height: 0;
    padding: 0;
    border-radius: var(--radius-sm);
    opacity: 0;
    transition: opacity var(--motion-control) var(--ease-out);
  }
  .art-strip li:hover .art-replace,
  .art-replace:focus-visible {
    opacity: 1;
  }
  /* A finger opens the picture and replaces it from the viewer's full-size buttons. */
  @media (any-pointer: coarse) {
    .art-replace {
      display: none;
    }
  }
</style>
