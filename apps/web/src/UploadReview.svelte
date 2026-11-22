<script lang="ts">
  import type { ContentClient, SystemSummary } from '@ecs/client';
  import ListMore from './components/ListMore.svelte';
  import { shownLabel } from './lib/batches';
  import { KIND_ORDER, kindLabel, systemLabel } from './lib/content-format';
  import type { UploadReview, UploadReviewEntry } from './lib/upload-review';
  import UploadTargetPicker from './UploadTargetPicker.svelte';
  let {
    controller,
    systems,
    client,
    libraryId,
    onauthorization = () => {},
  }: {
    controller: UploadReview;
    systems: SystemSummary[];
    client: ContentClient;
    libraryId: string;
    onauthorization?: (status: 401 | 403) => void;
  } = $props();
  let commonKind = $state('');
  let commonSystem = $state('');
  let picking = $state<string | null>(null);
  const waiting = $derived($controller.entries.filter((entry) => entry.errors.length).length);
  const attached = $derived($controller.entries.some((entry) => entry.kind && entry.kind !== 'rom'));
  /** What uploading this file will do, in one line. What is still missing is said below it. */
  function outcome(entry: UploadReviewEntry): string {
    if (!entry.kind) return 'Unknown kind of file';
    if (entry.kind === 'rom') {
      if (entry.target) return `Game file for ${entry.target.title}`;
      return systems.some((system) => system.identifier === entry.system)
        ? `New game · ${systemLabel(entry.system, systems)}`
        : 'New game';
    }
    return entry.target ? `${kindLabel(entry.kind)} for ${entry.target.title}` : kindLabel(entry.kind);
  }
  let editing = $state<Record<string, boolean>>({});
  /** The folder a file came with, when it came with one. */
  function folder(entry: UploadReviewEntry): string {
    const cut = entry.relativePath.lastIndexOf('/');
    return cut > 0 ? entry.relativePath.slice(0, cut) : '';
  }
</script>

<section aria-label="Upload review" class="upload-review">
  <header class="review-head">
    <h3>{$controller.entries.length.toLocaleString()} {$controller.entries.length === 1 ? 'file' : 'files'}</h3>
    <p class="dim">
      {waiting ? `${waiting.toLocaleString()} ${waiting === 1 ? 'needs' : 'need'} a choice before uploading` : 'Ready to upload'}
    </p>
  </header>
  <div class="review-all">
    <label>
      System
      <select bind:value={commonSystem} onchange={() => { if (commonSystem) controller.setCommonMetadata({ system: commonSystem }); }}>
        <option value="">Same system for every game…</option>
        {#each systems as system}<option value={system.identifier}>{system.name}</option>{/each}
      </select>
    </label>
    {#if attached}
      <button type="button" onclick={() => (picking = 'all')}>Choose the game for these files</button>
    {/if}
    <details class="review-more">
      <summary>More options</summary>
      <label>
        Kind for all files
        <select bind:value={commonKind} onchange={() => { if (commonKind) controller.setCommonMetadata({ kind: commonKind }); }}>
          <option value="">Choose a kind</option>
          {#each KIND_ORDER as kind}<option value={kind}>{kindLabel(kind)}</option>{/each}
        </select>
      </label>
    </details>
  </div>
  {#if picking}
    <UploadTargetPicker
      {client}
      {libraryId}
      {systems}
      heading={picking === 'all' ? 'Which game are these for?' : 'Which game is this for?'}
      {onauthorization}
      oncancel={() => (picking = null)}
      onchoose={(target) => {
        if (picking === 'all') controller.setCommonMetadata({ target });
        else if (picking) controller.setEntryMetadata(picking, { target });
        picking = null;
      }}
    />
  {/if}
  <ul class="upload-entries">
    {#each $controller.visible as entry (entry.id)}
      <li class:attention={entry.errors.length > 0}>
        <div class="entry-main">
          <div class="entry-text">
            <strong>{entry.file.name}</strong>
            <span class="dim">{outcome(entry)}{folder(entry) ? ` · in ${folder(entry)}` : ''}</span>
          </div>
          <div class="entry-actions">
            {#if entry.kind && entry.kind !== 'rom'}
              <button type="button" aria-label={`Choose game for ${entry.file.name}`} onclick={() => (picking = entry.id)}>
                {entry.target ? 'Change game' : 'Choose game'}
              </button>
            {/if}
            <button
              type="button"
              class="text-button"
              aria-label={`Edit ${entry.file.name}`}
              aria-expanded={!!editing[entry.id]}
              onclick={() => (editing = { ...editing, [entry.id]: !editing[entry.id] })}
            >{editing[entry.id] ? 'Done' : 'Edit'}</button>
          </div>
        </div>
        {#each entry.errors as error}<p class="problem entry-problem">{error}</p>{/each}
        <!-- Kept in the page while closed, so a change made for every file is already there when it opens. -->
        <div class="form-grid" hidden={!editing[entry.id]}>
          <label>Title for {entry.file.name}<input value={entry.title} onchange={(event) => controller.setEntryMetadata(entry.id, { title: event.currentTarget.value })} /></label>
          <label>Kind for {entry.file.name}<select value={entry.kind} onchange={(event) => controller.setEntryMetadata(entry.id, { kind: event.currentTarget.value })}><option value="">Choose a kind</option>{#each KIND_ORDER as kind}<option value={kind}>{kindLabel(kind)}</option>{/each}</select></label>
          {#if entry.kind === 'rom' && !entry.target}<label>System for {entry.file.name}<select value={entry.system} onchange={(event) => controller.setEntryMetadata(entry.id, { system: event.currentTarget.value })}><option value="">Choose a system</option>{#each systems as system}<option value={system.identifier}>{system.name}</option>{/each}</select></label>{/if}
        </div>
      </li>
    {/each}
  </ul>
  {#if $controller.entries.length > $controller.visible.length || $controller.visible.length > 50}<ListMore
      label={shownLabel($controller.visible.length, $controller.hasMore, ['file', 'files'], $controller.entries.length)}
      more={$controller.hasMore}
      action="Show more files"
      onmore={() => controller.more()}
    />{/if}
</section>

<style>
  .upload-review {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
  }
  .review-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2) var(--space-4);
  }
  .review-head h3,
  .review-head p {
    margin: 0;
  }
  .review-head p {
    font-size: var(--text-small);
  }
  .review-all {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--space-3);
  }
  .review-all > label {
    flex: 1 1 14rem;
  }
  .review-more {
    flex: 1 1 100%;
  }
  .review-more summary {
    width: fit-content;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: var(--text-small);
  }
  .review-more label {
    max-width: 20rem;
    margin-top: var(--space-2);
  }
  .upload-entries {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .upload-entries li {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-3) 0;
    border-top: var(--border-width) solid var(--color-border);
    overflow-wrap: anywhere;
  }
  .upload-entries li.attention {
    padding-inline-start: var(--space-3);
    border-inline-start: 3px solid var(--color-warning);
  }
  .entry-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .entry-text {
    display: grid;
    min-width: 0;
  }
  .entry-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
  }
  .entry-text .dim {
    font-size: var(--text-small);
  }
  .entry-problem {
    margin: 0;
    font-size: var(--text-small);
  }
  .form-grid[hidden] {
    display: none;
  }
  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
    gap: var(--space-3);
    margin-top: var(--space-2);
  }
</style>
