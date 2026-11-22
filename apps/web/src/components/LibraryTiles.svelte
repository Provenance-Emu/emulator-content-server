<script lang="ts">
  import type { ContentClient, Library } from '@ecs/client';
  import { onDestroy, untrack } from 'svelte';
  import { entryKey } from '../lib/content-format';
  import { createLibraryTiles, gameCountLabel } from '../lib/library-tiles';
  import Icon from './Icon.svelte';

  let {
    client,
    libraries,
    invalidation,
    onchoose,
    onsignedout,
  }: {
    client: ContentClient;
    libraries: Library[];
    /** Changes whenever the catalog does, so counts and covers follow a scan or an upload. */
    invalidation: number;
    onchoose: (libraryId: string) => void;
    onsignedout: () => void;
  } = $props();

  const tiles = untrack(() =>
    createLibraryTiles(client, {
      authorizationRejected: (status) => {
        if (status === 401) onsignedout();
      },
    }),
  );
  const ids = $derived(libraries.map((library) => library.id).join('\n'));
  $effect(() => {
    void invalidation;
    void tiles.load(ids ? ids.split('\n') : []);
  });
  onDestroy(() => tiles.dispose());
</script>

<div class="library-choice-grid" aria-label="Choose a library">
  {#each libraries as library (library.id)}
    {@const tile = $tiles.tiles[library.id]}
    {@const covers = (tile?.covers ?? []).filter((cover) => $tiles.urls[entryKey(cover)])}
    <button type="button" class="library-choice" aria-label={`Open library ${library.name}`} onclick={() => onchoose(library.id)}>
      <span class="library-choice-plate">
        <span class="library-choice-covers" class:empty={!covers.length}>
          {#each covers as cover (entryKey(cover))}
            <img src={$tiles.urls[entryKey(cover)]} alt="" loading="lazy" decoding="async" />
          {:else}
            <Icon name="games" />
          {/each}
        </span>
        <span class="library-choice-text">
          <strong>{library.name}</strong>
          <span class="library-choice-count">{tile ? gameCountLabel(tile.count) : ''}</span>
        </span>
        <span class="library-choice-arrow"><Icon name="arrow" /></span>
      </span>
    </button>
  {/each}
</div>
