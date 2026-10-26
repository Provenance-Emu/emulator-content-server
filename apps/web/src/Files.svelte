<script lang="ts">
  import type { ManifestFile, PlayerCoreDescriptor } from '@ecs/client';
  import type { DetailState } from './lib/detail';
  import { KIND_ORDER, kindLabel, saveGroups } from './lib/content-format';
  import { bytes } from './lib/format';
  import { assetPlayHref } from './player/links';
  let {
    detailState,
    playerCore,
    ondownload,
    onplay,
  }: {
    detailState: DetailState;
    playerCore: PlayerCoreDescriptor | null;
    ondownload: (file: ManifestFile) => void;
    onplay: (href: string) => void;
  } = $props();
  let selected = $state('overview');
  const playable = $derived.by(() => {
    const item = detailState.item;
    return item
      ? detailState.files.flatMap((file) => {
          const href = assetPlayHref(playerCore, item, file);
          return href ? [{ file, href }] : [];
        })
      : [];
  });
  const gameFiles = $derived(detailState.files.filter((file) => file.kind === 'rom'));
  function fileLabel(kind: string) {
    const labels: Record<string, string> = {
      rom: 'Game',
      battery_save: 'In-game save',
      save_state: 'Saved snapshot',
      bios: 'Console firmware (BIOS)',
    };
    return labels[kind] ?? kindLabel(kind);
  }
  const busy = $derived(!!detailState.reading || detailState.adopting || detailState.loading);
  const kinds = $derived(
    KIND_ORDER.filter((kind) => detailState.files.some((file) => file.kind === kind)),
  );
  const displayed = $derived(
    selected === 'overview'
      ? detailState.files
      : detailState.files.filter((file) => file.kind === selected),
  );
  const groups = $derived(saveGroups(displayed));
  const contentFiles = $derived(
    displayed
      .filter((file) => !['battery_save', 'save_state'].includes(file.kind))
      .sort((a, b) => Number(b.kind === 'rom') - Number(a.kind === 'rom')),
  );
</script>

<section class="game-launch" aria-label="Play this game">
  {#if playable.length === 1}
    <div>
      <h2>Ready to play</h2>
      <p>Play here in your browser, or download the game file below to use in your emulator.</p>
    </div>
    <button
      type="button"
      class="primary play-action"
      disabled={busy}
      onclick={() => onplay(playable[0]!.href)}
    >Play</button>
  {:else if playable.length > 1}
    <h2>Choose a game file to play</h2>
    <p>Use Play beside a game file below. You can also download it to use in your emulator.</p>
  {:else if gameFiles.length}
    <h2>Take this game to your emulator</h2>
    <p>Browser play is not available for this game on this server. Download the game file below and open it in an emulator that supports this console.</p>
  {:else}
    <h2>This game needs a game file</h2>
    <p>{detailState.canUpload ? 'Choose Add a file above to add the game. Saves and pictures can stay here too.' : 'Ask the library owner to add the game file. You can still download any saves or pictures below.'}</p>
  {/if}
</section>
<nav class="detail-tabs" aria-label="Detail file sections">
  <button
    type="button"
    aria-current={selected === 'overview' ? 'page' : undefined}
    onclick={() => (selected = 'overview')}
  >
    Overview
  </button>
  {#each kinds as kind}<button
      type="button"
      aria-current={selected === kind ? 'page' : undefined}
      onclick={() => (selected = kind)}
    >
      {fileLabel(kind)}
    </button>{/each}
</nav>
<section class="game-files">
  <h2>{selected === 'overview' ? 'Files & downloads' : fileLabel(selected)}</h2>
  {#if !displayed.length}<p class="dim">This game has no files yet.</p>{:else}<div
      class="table-scroll"
    >
      <table aria-label="Game files">
        <thead>
          <tr>
            <th>File</th>
            <th>Kind</th>
            <th>Size</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each contentFiles as file (file.id)}{@render row(
              file,
              false,
            )}{/each}
          {#each groups as group (group.path + (group.live?.kind ?? group.copies[0]?.kind))}{#if group.live}{@render row(
                group.live,
                false,
              )}{/if}{#each group.copies as file (file.id)}{@render row(file, true)}{/each}{/each}
        </tbody>
      </table>
    </div>{/if}
</section>
{#snippet row(file: ManifestFile, copy: boolean)}
  {@const play = detailState.item ? assetPlayHref(playerCore, detailState.item, file) : null}
  <tr>
    <td class="path file-name" data-label="File">
      {file.relativePath}{#if copy}<small class="dim">Preserved copy</small>{/if}
    </td>
    <td data-label="Type">{fileLabel(file.kind)}</td>
    <td data-label="Size">{bytes(file.size)}</td>
    <td data-label="Actions">
      <div class="actions">
        {#if play && playable.length > 1}<button
            type="button"
            class="primary"
            disabled={busy}
            aria-label={`Play ${file.relativePath}`}
            onclick={() => onplay(play)}
          >Play</button>{/if}
        <button
          type="button"
          aria-label={`Download ${file.relativePath}`}
          disabled={busy}
          onclick={() => ondownload(file)}
        >
          {detailState.reading?.id === file.id ? 'Downloading…' : 'Download'}
        </button>
      </div>
    </td>
  </tr>
{/snippet}
