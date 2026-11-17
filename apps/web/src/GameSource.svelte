<script lang="ts">
  import type { SourceFile, SystemSummary } from '@ecs/client';
  import { onDestroy, onMount, untrack } from 'svelte';
  import DiscConversion from './DiscConversion.svelte';
  import GameArtwork from './GameArtwork.svelte';
  import GameCopies from './GameCopies.svelte';
  import GameDetails from './GameDetails.svelte';
  import MatchingPanel from './MatchingPanel.svelte';
  import SourceOrganization from './SourceOrganization.svelte';
  import Icon from './components/Icon.svelte';
  import SavedPatches from './components/SavedPatches.svelte';
  import type { ServerContext } from './lib/application';
  import { availabilityLabel, systemLabel } from './lib/content-format';
  import type { DetailController } from './lib/detail';
  import { bytes } from './lib/format';
  import { createMatching } from './lib/matching';
  import { detailText } from './lib/matching-slots';
  import { sourcePlayHref, sourcePlayUnavailableReason } from './player/links';
  let {
    controller,
    context,
    playerCore,
    systems,
    owner,
    canEdit,
    selectedSource,
    gameCompanions = false,
    refreshing = false,
    saving = false,
    groupDownloading = false,
    groupFailure = null,
    onrefresh,
    onchanged,
    onauthorization = () => {},
    onemulators,
    ondownload,
    ondownloadset,
  }: {
    controller: DetailController;
    context: ServerContext;
    playerCore: import('./player/links').PlayableCores;
    systems: SystemSummary[];
    owner: boolean;
    /** May change this game's details and pictures: the owner, or an editor of its library. */
    canEdit: boolean;
    selectedSource: SourceFile;
    gameCompanions?: boolean;
    refreshing?: boolean;
    saving?: boolean;
    groupDownloading?: boolean;
    groupFailure?: string | null;
    onrefresh: () => void;
    onchanged: () => void;
    onauthorization?: (status: 401 | 403) => void;
    onemulators?: () => void;
    ondownload: (memberId?: string) => void;
    ondownloadset: () => void;
  } = $props();
  // One controller for the whole page, so the cover, details and lookup never disagree.
  const matching = untrack(() => createMatching(context.client, selectedSource.id));
  onMount(() => void matching.load());
  onDestroy(() => matching.dispose());
  let artwork = $state<ReturnType<typeof GameArtwork>>();
  let editing = $state(false);
  let expanded = $state(false);
  let patchRevision = $state(0);
  const source = $derived($controller.source ?? selectedSource);
  const name = $derived($controller.entry?.name ?? source.title ?? source.name);
  const metadata = $derived($matching.saved?.matches.find((match) => match.kind === 'metadata'));
  const details = $derived(detailText($matching.saved ? metadata?.metadata : source.details));
  const facts = $derived(
    [
      systemLabel($controller.entry?.systemId ?? source.systemId, systems),
      details.year,
      details.publisher,
      details.genre,
    ].filter(Boolean),
  );
  const play = $derived($controller.source ? sourcePlayHref(playerCore, $controller.source) : null);
  const set = $derived($controller.sourceFiles.length > 1);
  const busy = $derived(saving || groupDownloading || !!$controller.reading);
  const local = $derived($controller.source?.availability === 'local');
  const showPatches = $derived(gameCompanions && source.kind === 'rom');
  const convertible = $derived(
    owner &&
      source.kind === 'rom' &&
      source.availability === 'local' &&
      !source.groupError &&
      (/\.(cue|gdi)$/i.test(source.name) ||
        (/\.zip$/i.test(source.name) &&
          /\.(dreamcast|psx|segacd|saturn|pcecd|pcfx|3do|neogeocd|jaguarcd|cdi)$/.test(
            source.systemId ?? '',
          ))),
  );
  function changed() {
    patchRevision++;
    onchanged();
  }
</script>

{#if $matching.savedArtworkByRole.banner}
  <button
    type="button"
    class="game-banner"
    aria-label={`View banner for ${name}`}
    onclick={() => artwork?.open('banner')}
  >
    <img src={$matching.savedArtworkByRole.banner} alt="" />
  </button>
{/if}
<header class="game-hero">
  <button
    type="button"
    class="game-cover artwork"
    aria-label={$matching.savedArtwork ? `View artwork for ${name}` : 'Add a front cover'}
    disabled={!$matching.savedArtwork && !canEdit}
    onclick={() => artwork?.open('front')}
  >
    {#if $matching.savedArtwork}<img src={$matching.savedArtwork} alt="" />
    {:else}<span class="title-placeholder" aria-hidden="true">
        <span class="placeholder-system">{facts[0]}</span>
        <span class="placeholder-title">{name}</span>
      </span>{/if}
  </button>
  <div class="game-summary">
    <h1 tabindex="-1" data-detail-heading>{name}</h1>
    <p class="dim game-facts">{facts.join(' · ')}</p>
    <div class="actions game-actions">
      {#if play}<button class="primary" type="button" onclick={() => context.openPlayer(play)}>
          <Icon name="play" /> Play
        </button>{/if}
      {#if $controller.source}
        {#if set && !$controller.groupError}
          <button type="button" disabled={busy} onclick={ondownloadset}>
            <Icon name="download" /> {groupDownloading ? 'Downloading ZIP…' : 'Download complete set as ZIP'}
          </button>
        {:else if !set}
          <button
            type="button"
            aria-label={`Download ${$controller.source.name}`}
            disabled={busy || !local}
            onclick={() => ondownload()}
          >
            <Icon name="download" /> Download
          </button>
        {/if}
      {/if}
      {#if canEdit}<button type="button" disabled={editing} onclick={() => (editing = true)}>
          <Icon name="edit" /> Edit details
        </button>{/if}
      <button
        type="button"
        class="icon-only"
        aria-label="Refresh details"
        title="Refresh details"
        disabled={saving || refreshing || $controller.loading || !!$controller.reading}
        onclick={() => {
          patchRevision++;
          void matching.load();
          onrefresh();
        }}
      >
        <Icon name="refresh" />
      </button>
    </div>
    {#if $controller.source && !play && $controller.source.kind === 'rom' && local}
      <div class="play-note">
        <h2>Browser play needs attention</h2>
        <p>{sourcePlayUnavailableReason(playerCore, $controller.source)}</p>
        {#if owner && onemulators}<button type="button" onclick={onemulators}>Manage emulators</button>{/if}
      </div>
    {/if}
    {#if $controller.source && !local}<p class="dim">
        This file is unavailable while its server folder is offline.
      </p>{/if}
    {#if details.description}
      <p class="game-description" class:clamped={!expanded}>{details.description}</p>
      {#if details.description.length > 320}<button
          type="button"
          class="text-button"
          aria-expanded={expanded}
          onclick={() => (expanded = !expanded)}
        >{expanded ? 'Show less' : 'Show more'}</button>{/if}
    {/if}
  </div>
</header>
{#if $matching.failure}<p class="problem" role="alert">{$matching.failure}</p>{/if}
{#if $matching.savedLoadFailed}<button type="button" onclick={() => void matching.load()}>Load details again</button>{/if}

<GameArtwork
  bind:this={artwork}
  client={context.client}
  sourceId={selectedSource.id}
  {matching}
  {name}
  {canEdit}
  onchanged={changed}
/>
<GameDetails {matching} {source} {name} bind:editing onchanged={changed} />

{#if $controller.source}
  <section class="game-files" aria-label="Files">
    <h2>{set ? `Files · disc set of ${$controller.sourceFiles.length}` : 'Files'}</h2>
    {#if $controller.groupError}<p class="problem">
        {$controller.groupError} Rescan this library folder after fixing its disc files.
      </p>{/if}
    <ul class="file-rows">
      {#each set ? $controller.sourceFiles : [$controller.source] as file (file.id)}
        <li>
          <span class="path">{file.name}</span>
          <span class="dim">{bytes(file.size)} · {availabilityLabel(file.availability)}</span>
          {#if set}<button
              type="button"
              class="icon-only"
              aria-label={`Download ${file.name}`}
              title="Download this file"
              disabled={busy || file.availability !== 'local'}
              onclick={() => ondownload(file.id)}
            ><Icon name="download" /></button>{/if}
        </li>
      {/each}
    </ul>
    {#if set}<p class="dim">
        The ZIP keeps the original folder layout so CUE and playlist references work.
      </p>{/if}
    {#if groupFailure}<p class="problem" role="alert">{groupFailure}</p>{/if}
  </section>
{/if}

{#if showPatches}{#key patchRevision}
  <SavedPatches client={context.client} sourceId={selectedSource.id} {onauthorization} />
{/key}{/if}

<section class="game-manage" aria-label="Manage this game">
  <h2>Manage</h2>
  <details class="game-task">
    <summary>
      <strong>{owner ? 'Look up details and artwork' : 'Saved matches'}</strong>
      <span class="dim">{owner ? 'Search for details, pictures, patches and cheats' : 'What has been saved for this game'}</span>
    </summary>
    <MatchingPanel
      {context}
      {owner}
      controller={matching}
      onchanged={changed}
      showLegacyPatchDownload={!showPatches}
      sourceId={selectedSource.id}
      sourceName={selectedSource.name}
    />
  </details>
  {#if owner && source.libraryId && source.systemId && source.kind === 'rom'}
    <details class="game-task">
      <summary>
        <strong>Other copies</strong>
        <span class="dim">Join this file to a game that has more than one copy</span>
      </summary>
      <GameCopies
        client={context.client}
        item={null}
        {source}
        cores={playerCore}
        {owner}
        onchanged={() => { onchanged(); onrefresh(); }}
        onplay={(href) => context.openPlayer(href)}
      />
    </details>
  {/if}
  {#if convertible}
    <details class="game-task">
      <summary>
        <strong>Convert disc to CHD</strong>
        <span class="dim">One smaller file in place of the disc image</span>
      </summary>
      <DiscConversion
        client={context.client}
        rootId={selectedSource.rootId}
        sourceId={selectedSource.id}
        onconverted={() => { onchanged(); onrefresh(); }}
      />
    </details>
  {/if}
  {#if owner && selectedSource.kind === 'rom'}
    <details class="game-task">
      <summary>
        <strong>Organize file</strong>
        <span class="dim">Rename or move it under its system and title</span>
      </summary>
      <SourceOrganization
        {context}
        {owner}
        sourceRootId={selectedSource.rootId}
        sourceId={selectedSource.id}
        libraryId={selectedSource.libraryId}
        onchanged={() => { onchanged(); onrefresh(); }}
      />
    </details>
  {/if}
</section>

<style>
  .game-hero {
    display: grid;
    grid-template-columns: minmax(7rem, 12rem) minmax(0, 1fr);
    gap: var(--space-6);
    align-items: start;
    margin-top: var(--space-4);
  }
  .game-banner {
    display: block;
    width: 100%;
    max-height: 10rem;
    min-height: 0;
    margin-top: var(--space-4);
    padding: 0;
    overflow: hidden;
    border-radius: var(--radius-panel);
    cursor: pointer;
  }
  .game-banner img {
    display: block;
    width: 100%;
    height: 100%;
    max-height: 10rem;
    object-fit: cover;
  }
  .game-cover {
    min-height: 0;
    margin: 0;
    padding: 0;
    cursor: pointer;
  }
  .game-cover:disabled {
    cursor: default;
    opacity: 1;
  }
  h1 {
    margin: 0 0 var(--space-1);
  }
  .game-facts {
    margin: 0 0 var(--space-4);
  }
  .game-actions {
    justify-content: flex-start;
    margin-bottom: var(--space-4);
  }
  .game-actions button,
  .file-rows button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .icon-only {
    justify-content: center;
    width: var(--control-height, var(--control-height-touch));
    min-width: 0;
    padding: 0;
  }
  .play-note h2 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-body);
  }
  .play-note p {
    margin: 0 0 var(--space-2);
  }
  .game-description {
    max-width: var(--content-measure);
    margin: 0;
    white-space: pre-line;
  }
  .game-description.clamped {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
    line-clamp: 4;
  }
  .file-rows {
    display: grid;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .file-rows li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-3);
  }
  .file-rows .path {
    flex: 1 1 12rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .game-task {
    border-top: var(--border-width) solid var(--color-border);
  }
  .game-task summary {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-3);
    min-height: var(--control-height-touch);
    padding: var(--space-3) 0;
  }
  .game-task summary .dim {
    font-size: var(--text-small);
  }
  .game-task[open] {
    padding-bottom: var(--space-4);
  }
  @media (max-width: 640px) {
    .game-hero {
      grid-template-columns: minmax(0, 1fr);
    }
    .game-cover {
      width: 9rem;
    }
  }
</style>
