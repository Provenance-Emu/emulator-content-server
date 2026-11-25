<script lang="ts">
  import type { LibraryBrowseEntry, SystemSummary } from '@ecs/client';
  import { entryKey, systemLabel } from '../lib/content-format';
  import SystemIcon from './SystemIcon.svelte';
  let {
    items,
    systems,
    urls,
    onopen,
  }: {
    items: LibraryBrowseEntry[];
    systems: SystemSummary[];
    urls: Record<string, string>;
    onopen: (entry: LibraryBrowseEntry) => void;
  } = $props();
  let failed = $state<Record<string, string>>({});
</script>

<!-- What this account played last, on any device: one row that scrolls sideways. -->
<section class="recent-games" aria-labelledby="recent-games-title">
  <h2 id="recent-games-title">Recently played</h2>
  <ul>
    {#each items as entry (entryKey(entry))}{@const url = urls[entryKey(entry)]}<li>
        <button type="button" class="game-card" aria-label={`Open ${entry.name}`} onclick={() => onopen(entry)}>
          <span class="artwork">
            {#if url && failed[entryKey(entry)] !== url}<img
                src={url}
                decoding="async"
                alt=""
                onerror={() => (failed = { ...failed, [entryKey(entry)]: url })}
              />{:else}<span class="title-placeholder" aria-hidden="true">
                <span class="placeholder-system"><SystemIcon system={entry.systemId} />{systemLabel(entry.systemId, systems)}</span>
              </span>{/if}
          </span>
          <strong title={entry.name}>{entry.name}</strong>
        </button>
      </li>{/each}
  </ul>
</section>
