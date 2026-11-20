<script lang="ts">
  import { ContentError, type ManifestFile, type SystemSummary } from '@ecs/client';
  import { onDestroy, tick, untrack } from 'svelte';
  import Files from './Files.svelte';
  import GameCopies from './GameCopies.svelte';
  import FormField from './components/FormField.svelte';
  import Icon from './components/Icon.svelte';
  import PictureViewer from './components/PictureViewer.svelte';
  import type { ServerContext } from './lib/application';
  import { kindLabel, systemLabel } from './lib/content-format';
  import type { DetailController } from './lib/detail';
  import { createItemPictures } from './lib/item-pictures';
  import { explain } from './lib/problems';
  import { assetPlayHref, playUnavailableReason } from './player/links';
  let {
    controller,
    context,
    playerCore,
    systems,
    owner,
    refreshing = false,
    externalBusy = false,
    onrefresh,
    onchanged,
    onauthorization = () => {},
    onemulators,
    ondownload,
    onaddfile,
    ontrashitem,
    ontrashfile,
  }: {
    controller: DetailController;
    context: ServerContext;
    playerCore: import('./player/links').PlayableCores;
    systems: SystemSummary[];
    owner: boolean;
    refreshing?: boolean;
    /** A download or a move to the trash started from this page is still running. */
    externalBusy?: boolean;
    onrefresh: () => void;
    onchanged: () => void;
    onauthorization?: (status: 401 | 403) => void;
    onemulators?: () => void;
    ondownload: (file: ManifestFile) => void;
    onaddfile: () => void;
    ontrashitem: () => void;
    ontrashfile: (file: ManifestFile) => void;
  } = $props();
  let disposed = false;
  const gallery = untrack(() =>
    createItemPictures(context.client, { authorizationRejected: (status) => onauthorization(status) }),
  );
  onDestroy(() => {
    disposed = true;
    gallery.dispose();
  });
  const item = $derived($controller.item);
  /** The title just saved here, shown until the collection's row for this game catches up. */
  let renamed = $state<{ id: string; title: string } | null>(null);
  const name = $derived(
    (renamed && renamed.id === item?.id ? renamed.title : null) ??
      $controller.entry?.name ??
      item?.title ??
      'Game',
  );
  const canEdit = $derived($controller.canUpload);
  const busy = $derived(
    externalBusy || !!$controller.reading || $controller.adopting || $controller.loading,
  );
  const playable = $derived(
    item
      ? $controller.files.flatMap((file) => {
          const href = assetPlayHref(playerCore, item, file);
          return href ? [{ file, href }] : [];
        })
      : [],
  );
  const gameFiles = $derived($controller.files.filter((file) => file.kind === 'rom'));
  const pictures = $derived(
    $controller.files.filter(
      (file) => (file.kind === 'artwork' || file.kind === 'screenshot') && !file.conflictOf,
    ),
  );
  $effect(() => gallery.show(pictures));
  const fileName = (file: ManifestFile) => file.relativePath.split('/').at(-1) ?? file.relativePath;
  /** The picture the collection shows for this game, then any artwork, then any picture. */
  const cover = $derived.by(() => {
    const preferred = $controller.entry?.previewAsset?.id;
    return (
      pictures.find((file) => file.id === preferred && $gallery.urls[file.id]) ??
      pictures.find((file) => file.kind === 'artwork' && $gallery.urls[file.id]) ??
      pictures.find((file) => $gallery.urls[file.id]) ??
      null
    );
  });
  let viewing = $state<string | null>(null);
  let renaming = $state(false);
  let title = $state('');
  let saving = $state(false);
  let renameFailure = $state<string | null>(null);
  let form = $state<HTMLFormElement>();
  function startRename() {
    title = name;
    renameFailure = null;
    renaming = true;
    void tick().then(() => form?.querySelector<HTMLInputElement>('input')?.select());
  }
  async function rename() {
    const next = title.trim();
    if (!item || !next || saving) return;
    if (next === name) {
      renaming = false;
      return;
    }
    saving = true;
    renameFailure = null;
    try {
      const saved = await context.client.renameItem(item.id, next, item.revision);
      if (disposed) return;
      renamed = { id: saved.id, title: saved.title };
      renaming = false;
      onchanged();
      onrefresh();
    } catch (error) {
      if (disposed) return;
      if (error instanceof ContentError && (error.status === 401 || error.status === 403))
        onauthorization(error.status);
      renameFailure = explain(error);
    } finally {
      if (!disposed) saving = false;
    }
  }
</script>

<header class="game-hero">
  <button
    type="button"
    class="game-cover artwork"
    aria-label={cover ? `View pictures of ${name}` : 'Add a picture'}
    disabled={cover ? false : !canEdit}
    onclick={() => (cover ? (viewing = cover.id) : onaddfile())}
  >
    {#if cover}<img src={$gallery.urls[cover.id]} alt="" />
    {:else}<span class="title-placeholder" aria-hidden="true">
        <span class="placeholder-system">{systemLabel($controller.entry?.systemId ?? null, systems)}</span>
        <span class="placeholder-title">{name}</span>
      </span>{/if}
  </button>
  <div class="game-summary">
    {#if renaming}
      <form
        bind:this={form}
        class="game-rename"
        onsubmit={(event) => {
          event.preventDefault();
          void rename();
        }}
      >
        <FormField label="Game title">
          {#snippet children(attributes)}
            <input {...attributes} bind:value={title} required maxlength="256" disabled={saving} />
          {/snippet}
        </FormField>
        <button class="primary" type="submit" disabled={saving || !title.trim()}>
          {saving ? 'Saving…' : 'Save title'}
        </button>
        <button type="button" disabled={saving} onclick={() => (renaming = false)}>Cancel</button>
      </form>
      {#if renameFailure}<p class="problem" role="alert">{renameFailure}</p>{/if}
    {:else}
      <h1 tabindex="-1" data-detail-heading>{name}</h1>
    {/if}
    <p class="dim game-facts">{systemLabel($controller.entry?.systemId ?? null, systems)}</p>
    <div class="actions game-actions">
      {#if playable.length === 1}<button
          class="primary"
          type="button"
          disabled={busy}
          onclick={() => context.openPlayer(playable[0]!.href)}
        >
          <Icon name="play" /> Play
        </button>{/if}
      {#if canEdit && item}
        <button type="button" onclick={onaddfile}><Icon name="plus" /> Add a file</button>
        <button type="button" disabled={renaming} onclick={startRename}>
          <Icon name="edit" /> Rename
        </button>
      {/if}
      <button
        type="button"
        class="icon-only"
        aria-label="Refresh details"
        title="Refresh details"
        disabled={externalBusy || refreshing || $controller.loading || !!$controller.reading || $controller.adopting}
        onclick={onrefresh}
      >
        <Icon name="refresh" />
      </button>
    </div>
    {#if playable.length > 1}
      <p class="dim">This game has more than one playable file. Use Play beside the one you want.</p>
    {:else if !playable.length && gameFiles.length}
      <div class="play-note">
        <h2>Browser play needs attention</h2>
        <p>
          {playUnavailableReason(
            playerCore,
            item?.systemIdentifier ?? null,
            gameFiles[0]!.relativePath,
            gameFiles[0]!.kind,
            gameFiles[0]!.size,
          )}
        </p>
        {#if onemulators}<button type="button" onclick={onemulators}>Manage emulators</button>{/if}
      </div>
    {:else if !playable.length && !$controller.loading}
      <div class="play-note">
        <h2>This game needs a game file</h2>
        <p>
          {canEdit
            ? 'Choose Add a file to add the game. Saves and pictures can stay here too.'
            : 'Ask the library owner to add the game file. You can still download any saves or pictures below.'}
        </p>
      </div>
    {/if}
  </div>
</header>

{#if pictures.length || canEdit}
  <section class="game-artwork" aria-label="Pictures">
    <h2>Pictures</h2>
    <ul class="picture-strip">
      {#each pictures as file (file.id)}
        <li>
          <button
            type="button"
            class="picture-tile"
            aria-label={`View ${fileName(file)}`}
            onclick={() => (viewing = file.id)}
          >
            {#if $gallery.urls[file.id]}<img src={$gallery.urls[file.id]} alt="" />
            {:else if $gallery.pending[file.id]}<span class="dim">Loading…</span>
            {:else}<span class="dim">{fileName(file)}</span>{/if}
          </button>
          <span class="picture-label">{kindLabel(file.kind)}</span>
        </li>
      {/each}
      {#if canEdit}
        <li>
          <button
            type="button"
            class="picture-tile empty"
            aria-label="Add a picture"
            title="Add a picture"
            onclick={onaddfile}
          ><Icon name="plus" /></button>
          <span class="picture-label">Add</span>
        </li>
      {/if}
    </ul>
  </section>
{/if}

<PictureViewer
  title={`Pictures of ${name}`}
  pictures={pictures.map((file) => ({
    key: file.id,
    label: fileName(file),
    alt: `${fileName(file)} for ${name}`,
    url: $gallery.urls[file.id] ?? null,
    pending: !!$gallery.pending[file.id],
  }))}
  bind:viewing
  busy={externalBusy}
>
  {#snippet caption(picture)}
    <strong>{picture.label}</strong>
    <span class="dim">{kindLabel(pictures.find((file) => file.id === picture.key)?.kind ?? 'artwork')}</span>
  {/snippet}
  {#snippet tools(picture)}
    {@const file = pictures.find((candidate) => candidate.id === picture.key)}
    {#if file}
      <button
        type="button"
        class="icon-button"
        aria-label={`Download picture ${picture.label}`}
        title="Download"
        disabled={busy}
        onclick={() => ondownload(file)}
      ><Icon name="download" /></button>
      {#if canEdit}<button
          type="button"
          class="icon-button"
          aria-label={`Move picture ${picture.label} to trash`}
          title="Move to trash (kept for 30 days)"
          disabled={busy}
          onclick={() => ontrashfile(file)}
        ><Icon name="trash" /></button>{/if}
    {/if}
  {/snippet}
</PictureViewer>

<Files
  detailState={$controller}
  launch={false}
  {externalBusy}
  {playerCore}
  {onemulators}
  ontrash={canEdit ? ontrashfile : undefined}
  {ondownload}
  onplay={(href) => context.openPlayer(href)}
/>

{#if item}
  <section class="game-manage" aria-label="Manage this game">
    <h2>Manage</h2>
    <details class="game-task">
      <summary>
        <strong>Other copies</strong>
        <span class="dim">Other files on the server that are this same game</span>
      </summary>
      {#key `${context.key}:${item.id}`}
        <GameCopies
          client={context.client}
          {item}
          source={null}
          cores={playerCore}
          {owner}
          onchanged={() => { onchanged(); onrefresh(); }}
          onplay={(href) => context.openPlayer(href)}
        />
      {/key}
    </details>
    {#if canEdit}
      <div class="game-task game-task-row">
        <span>
          <strong>Move to trash</strong>
          <span class="dim">The game and its files are kept for 30 days and can be restored</span>
        </span>
        <button type="button" disabled={busy} onclick={ontrashitem}>
          <Icon name="trash" /> Move to trash
        </button>
      </div>
    {/if}
  </section>
{/if}

<style>
  .game-rename {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }
  .game-rename :global(.form-field) {
    flex: 1 1 14rem;
  }
  .game-rename :global(input) {
    width: 100%;
  }
  .picture-strip {
    display: flex;
    gap: var(--space-3);
    margin: 0;
    padding: 0 0 var(--space-1);
    overflow-x: auto;
    list-style: none;
  }
  .picture-strip li {
    display: grid;
    flex: 0 0 6.5rem;
    gap: var(--space-1);
    justify-items: center;
  }
  .picture-tile {
    display: grid;
    place-items: center;
    width: 100%;
    height: 6.5rem;
    min-height: 0;
    padding: var(--space-1);
    overflow: hidden;
    border-radius: var(--radius-control);
    background: var(--color-surface-inset);
    box-shadow: none;
    font-size: var(--text-small);
    overflow-wrap: anywhere;
  }
  .picture-tile:has(img) {
    padding: 0;
  }
  .picture-tile img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .picture-tile.empty {
    border-style: dashed;
    background: transparent;
    color: var(--color-text-muted);
  }
  .picture-label {
    color: var(--color-text-muted);
    font-size: var(--text-small);
  }
  .game-task-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2) var(--space-4);
    padding: var(--space-3) 0;
  }
  .game-task-row > span {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-3);
  }
  .game-task-row .dim {
    font-size: var(--text-small);
  }
  .game-task-row button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
</style>
