<script lang="ts">
  import type { ContentClient, FolderListing } from '@ecs/client';
  import { explain } from './lib/problems';

  let {
    client,
    onchoose,
    oncancel,
  }: { client: ContentClient; onchoose: (path: string) => void; oncancel: () => void } = $props();

  let listing = $state<FolderListing | null>(null);
  let failure = $state<string | null>(null);

  // Browsing happens on the server, because the folder being chosen is on the
  // server. A file input would offer this machine's disk and hand back names
  // relative to a sandbox rather than the absolute path the server needs.
  async function open(path: string | null): Promise<void> {
    failure = null;
    try {
      listing = await client.folders(path);
    } catch (error) {
      failure = explain(error);
    }
  }

  void open(null);
</script>

<div class="picker">
  {#if listing}
    <div class="places">
      {#each listing.places as place (place.path)}
        <button type="button" onclick={() => open(place.path)}>{place.label}</button>
      {/each}
    </div>
    <div class="row">
      <span class="path">{listing.path}</span>
      <span>
        <button type="button" disabled={!listing.parent} onclick={() => open(listing?.parent ?? null)}>
          Up
        </button>
        <button type="button" onclick={() => onchoose(listing?.path ?? '')}>Use this folder</button>
        <button type="button" onclick={oncancel}>Cancel</button>
      </span>
    </div>
    <ul class="folders">
      {#each listing.entries as entry (entry.path)}
        <li><button type="button" onclick={() => open(entry.path)}>{entry.name}</button></li>
      {:else}
        <li class="dim">No folders inside this one.</li>
      {/each}
    </ul>
  {:else if !failure}
    <p class="dim">Reading folders on the server.</p>
  {/if}
  {#if failure}
    <p class="problem">{failure}</p>
  {/if}
</div>

<style>
  .picker {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.75rem;
    margin: 0.75rem 0;
  }

  .places {
    display: flex;
    gap: 0.4rem;
    margin-bottom: 0.6rem;
  }

  .folders {
    list-style: none;
    margin: 0.6rem 0 0;
    padding: 0;
    max-height: 13rem;
    overflow-y: auto;
  }

  .folders li {
    border-top: 1px solid var(--line);
  }

  .folders button {
    background: none;
    border: none;
    border-radius: 0;
    padding: 0.4rem 0;
    width: 100%;
    text-align: left;
  }

  .folders button:hover {
    color: var(--accent);
  }
</style>
