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
  const kinds = $derived(
    KIND_ORDER.filter((kind) => detailState.files.some((file) => file.kind === kind)),
  );
  const displayed = $derived(
    selected === 'overview'
      ? detailState.files
      : detailState.files.filter((file) => file.kind === selected),
  );
  const groups = $derived(saveGroups(displayed));
</script>

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
      {kindLabel(kind)}
    </button>{/each}
</nav>
<section>
  <h2>{selected === 'overview' ? 'Game files' : kindLabel(selected)}</h2>
  {#if !displayed.length}<p class="dim">This game has no files yet.</p>{:else}<div
      class="table-scroll"
    >
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Kind</th>
            <th>Size</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each displayed.filter((file) => !['battery_save', 'save_state'].includes(file.kind)) as file (file.id)}{@render row(
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
    <td class="path">
      {file.relativePath}{#if copy}<small class="dim">Preserved copy</small>{/if}
    </td>
    <td>{kindLabel(file.kind)}</td>
    <td>{bytes(file.size)}</td>
    <td>
      <div class="actions">
        {#if play}<button type="button" onclick={() => onplay(play)}>Play</button>{/if}
        <button
          type="button"
          aria-label={`Download ${file.relativePath}`}
          disabled={!!detailState.reading || detailState.adopting || detailState.loading}
          onclick={() => ondownload(file)}
        >
          Download
        </button>
      </div>
    </td>
  </tr>
{/snippet}
