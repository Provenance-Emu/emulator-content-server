<script lang="ts" module>
  /** The height of a drawn card, kept between visits to the grid. */
  let cardSize = 0;
</script>

<script lang="ts">
  import type { LibraryBrowseEntry, SystemSummary } from '@ecs/client';
  import { onDestroy } from 'svelte';
  import { availabilityLabel, entryKey, fileTypeLabel, kindLabel, systemLabel } from '../lib/content-format';
  import { bytes } from '../lib/format';
  let {
    items,
    systems,
    urls,
    grid,
    onopen,
    onvisible,
  }: {
    items: LibraryBrowseEntry[];
    systems: SystemSummary[];
    urls: Record<string, string>;
    grid: boolean;
    onopen: (entry: LibraryBrowseEntry) => void;
    /** Cards on or near the screen. Called again when they are read again. */
    onvisible?: (entries: LibraryBrowseEntry[]) => void;
  } = $props();
  let failed = $state<Record<string, string>>({});
  const byKey = $derived(new Map(items.map((entry) => [entryKey(entry), entry])));
  const near = new Set<string>();
  let observer: IntersectionObserver | null = null;
  let scheduled = false;
  function report() {
    scheduled = false;
    const entries = [...near].flatMap((key) => byKey.get(key) ?? []);
    if (entries.length) onvisible?.(entries);
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(report);
  }
  /** Covers are only asked for while their card is within a screen or so of the viewport. */
  function watch(node: HTMLElement, key: string) {
    observer ??= new IntersectionObserver(
      (records) => {
        for (const record of records) {
          const target = (record.target as HTMLElement).dataset.entryKey ?? '';
          if (record.isIntersecting) near.add(target);
          else near.delete(target);
        }
        schedule();
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(node);
    return {
      destroy() {
        observer?.unobserve(node);
        near.delete(key);
      },
    };
  }
  $effect(() => {
    // A refresh replaces the entries behind cards that stay on screen.
    void byKey;
    schedule();
  });
  /**
   * Cards away from the screen are not laid out (`content-visibility` in app.css), so the page
   * needs their height to keep its length and the scroll position honest. It is measured from
   * the first card, which changes with the width of the window.
   */
  function measure(list: HTMLElement) {
    if (typeof ResizeObserver === 'undefined') return {};
    const apply = () => {
      if (cardSize > 0) list.style.setProperty('--game-card-size', `${cardSize}px`);
    };
    // The grid is rebuilt when a game is closed, and the place in it is restored straight away.
    apply();
    let watched: Element | null = null;
    const sizes = new ResizeObserver((records) => {
      // Not rounded: a fraction of a pixel a card adds up to a visible shift over a long list.
      const height = records[0]?.borderBoxSize?.[0]?.blockSize ?? 0;
      if (height <= 0 || height === cardSize) return;
      cardSize = height;
      apply();
    });
    // The card inside the first place is only sized while it is drawn, so a place that has
    // scrolled away never reports the estimate back as a measurement.
    const follow = () => {
      const first = list.firstElementChild?.firstElementChild ?? null;
      if (first === watched) return;
      if (watched) sizes.unobserve(watched);
      watched = first;
      if (first) sizes.observe(first);
    };
    const children = new MutationObserver(follow);
    children.observe(list, { childList: true });
    follow();
    return {
      destroy() {
        children.disconnect();
        sizes.disconnect();
      },
    };
  }
  onDestroy(() => observer?.disconnect());
</script>

{#if grid}
  <ul class="game-grid" aria-label="Collection results" use:measure>
    {#each items as entry (entryKey(entry))}<li>
        <button
          type="button"
          class="game-card"
          use:watch={entryKey(entry)}
          data-entry-key={entryKey(entry)}
          aria-label={`Open ${entry.name}`}
          onclick={() => onopen(entry)}
        >
          <span class="artwork">
            {#if urls[entryKey(entry)] && failed[entryKey(entry)] !== urls[entryKey(entry)]}<img
                src={urls[entryKey(entry)]}
                decoding="async"
                alt=""
                onerror={() => {
                  failed = {
                    ...failed,
                    [entryKey(entry)]: urls[entryKey(entry)] ?? '',
                  };
                }}
              />{:else}<span class="title-placeholder" aria-hidden="true">
                <span class="placeholder-system">{systemLabel(entry.systemId, systems)}</span>
                <span class="placeholder-title">{entry.name}</span>
              </span>{/if}
          </span>
          <strong>{entry.name}</strong>
          {#if entry.parentItem}<span class="game-parent dim">{entry.parentItem.title}</span>{/if}
          <span class="dim">{systemLabel(entry.systemId, systems)}{#if fileTypeLabel(entry)} · {fileTypeLabel(entry)}{/if}</span>
          {#if entry.source}<span class="availability">
              {availabilityLabel(entry.source.availability)}{#if (entry.source.groupFileCount ?? 0) > 1} · {entry.source.groupFileCount} files{/if}
            </span>{/if}
        </button>
      </li>{/each}
  </ul>
{:else if items.length}
  <div class="table-scroll">
    <table aria-label="Collection results">
      <thead>
        <tr>
          <th>Name</th>
          <th>System</th>
          <th>Kind</th>
          <th>Size / state</th>
        </tr>
      </thead>
      <tbody>
        {#each items as entry (entryKey(entry))}<tr>
            <td>
              <button
                type="button"
                class="text-button collection-name"
                data-entry-key={entryKey(entry)}
                aria-label={`Open ${entry.name}`}
                onclick={() => onopen(entry)}
              >
                {entry.name}
              </button>
              {#if entry.parentItem}<small class="dim">{entry.parentItem.title}</small>{/if}
            </td>
            <td>{systemLabel(entry.systemId, systems)}</td>
            <td>{kindLabel(entry.asset?.kind ?? entry.source?.kind ?? 'rom')}{#if fileTypeLabel(entry)} · {fileTypeLabel(entry)}{/if}</td>
            <td>
              {#if entry.source}{bytes(entry.source.size)} · {availabilityLabel(
                  entry.source.availability,
                )}{:else if entry.asset}{bytes(entry.asset.size)}{#if entry.asset.conflictOf}
                  · Preserved copy{/if}{:else}Game{/if}
            </td>
          </tr>{/each}
      </tbody>
    </table>
  </div>
{/if}
