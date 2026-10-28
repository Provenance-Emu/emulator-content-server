<script lang="ts">
  import type { ContentClient, FolderListing } from '@ecs/client';
  import { onDestroy, untrack } from 'svelte';
  import type { FolderSelection } from './lib/folder-selection';
  import { explain } from './lib/problems';
  let { client, contextKey, origin = window.location.origin, title, submitLabel, onsubmit, oncancel, onbusy = () => {} }: {
    client: ContentClient; contextKey: string; origin?: string; title: string; submitLabel: string;
    onsubmit: (selection: FolderSelection) => Promise<boolean>; oncancel: () => void; onbusy?: (busy: boolean) => void;
  } = $props();
  const key = untrack(() => contextKey);
  let listing = $state<FolderListing | null>(null);
  let path = $state('');
  let name = $state('');
  let failure = $state<string | null>(null);
  let reading = $state(false);
  let busy = $state(false);
  let generation = 0;
  let disposed = false;
  async function open(folder: string | null) {
    const run = ++generation;
    reading = true; failure = null;
    try {
      const result = await client.folders(folder);
      if (!disposed && key === contextKey && run === generation) { listing = result; path = result.path; }
    } catch (error) { if (!disposed && run === generation) failure = explain(error); }
    finally { if (!disposed && run === generation) reading = false; }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || disposed || key !== contextKey || !path.trim()) return;
    generation++; reading = false; busy = true; onbusy(true); failure = null;
    try {
      const accepted = await onsubmit({ path: path.trim(), suggestedName: name.trim(), origin, contextKey: key });
      if (!disposed && key === contextKey) {
        if (accepted) oncancel();
        else failure = 'The folder could not be selected. Check the path and try again.';
      }
    } catch (error) { if (!disposed && key === contextKey) failure = explain(error); }
    finally { if (!disposed) { busy = false; onbusy(false); } }
  }
  untrack(() => { void open(null); });
  onDestroy(() => { disposed = true; generation++; });
</script>
<section aria-label={title} class="picker folder-picker">
  <p class="picker-intro dim">Browse folders on the computer running Emulation Server. This does not copy files from your device.</p>
  <form class="picker-form" onsubmit={submit}>
    <div class="picker-path-row">
      <label>Server folder path<input bind:value={path} required disabled={busy} placeholder="/Volumes/Games" oninput={() => { generation++; reading = false; }} /></label>
      <button type="button" disabled={busy || reading || !path.trim()} onclick={() => void open(path.trim())}>Browse path</button>
    </div>
    {#if listing}
      <div class="folder-browser" aria-busy={reading}>
        <nav class="folder-places" aria-label="Places on server">
          <span class="places-label dim">Places</span>
          {#each listing.places as place (place.path)}
            <button type="button" aria-current={place.path === listing.path ? 'location' : undefined} disabled={busy || reading} onclick={() => void open(place.path)}>{place.label}</button>
          {/each}
        </nav>
        <div class="folder-location">
          <div class="folder-location-bar">
            <button type="button" title="Up one folder" disabled={busy || reading || !listing.parent} onclick={() => void open(listing?.parent ?? null)}>Up</button>
            <div><span class="dim">Current folder</span><span class="path">{listing.path}</span></div>
          </div>
          <ul class="folder-entries" aria-label="Folders inside this folder">
            {#each listing.entries as entry (entry.path)}
              <li><button type="button" disabled={busy || reading} title={entry.name} onclick={() => void open(entry.path)}>
                  <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4H10l2 3h7.5A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V7Z" /></svg>
                  <span class="folder-entry-name">{entry.name}</span><span aria-hidden="true" class="dim">›</span>
                </button></li>
            {:else}<li class="folder-empty dim">No folders inside this one. You can still choose this folder.</li>{/each}
          </ul>
        </div>
      </div>
    {/if}
    {#if reading}<p class="picker-status dim" role="status">Reading folders on the server…</p>{/if}
    {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
    <label class="picker-name">Folder name (optional)<input bind:value={name} maxlength="80" disabled={busy} placeholder="Uses the folder name" /></label>
    <div class="picker-actions">
      <button type="button" disabled={busy} onclick={oncancel}>Cancel</button>
      <button class="primary" type="submit" disabled={busy || !path.trim()}>{busy ? 'Working…' : submitLabel}</button>
    </div>
  </form>
</section>
<style>
  .picker-intro { margin: 0 0 1rem; max-width: 60ch; }
  .picker-form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; }
  .picker-path-row { display: flex; align-items: end; gap: .5rem; min-width: 0; }
  .picker-path-row label { flex: 1; min-width: 0; }
  .picker-path-row input { width: 100%; }
  .picker-path-row button { flex-shrink: 0; }
  .folder-browser { display: grid; grid-template-columns: 10rem minmax(0, 1fr); border: 1px solid var(--line); border-radius: .5rem; overflow: hidden; }
  .folder-places { display: flex; flex-direction: column; align-items: stretch; gap: .25rem; padding: .65rem; background: #171c20; border-right: 1px solid var(--line); }
  .places-label { padding: .25rem .5rem; font-size: .8rem; }
  .folder-places button { text-align: left; border-color: transparent; background: transparent; padding-inline: .5rem; overflow-wrap: anywhere; }
  .folder-places button[aria-current="location"] { background: #263945; border-color: #476b82; }
  .folder-location { min-width: 0; }
  .folder-location-bar { display: flex; align-items: center; gap: .75rem; padding: .75rem; border-bottom: 1px solid var(--line); }
  .folder-location-bar > div { display: grid; gap: .15rem; min-width: 0; font-size: .85rem; }
  .folder-location-bar button { flex-shrink: 0; }
  .folder-entries { list-style: none; padding: .25rem; margin: 0; height: clamp(11rem, 32dvh, 18rem); overflow-y: auto; overscroll-behavior: contain; }
  .folder-entries button { display: flex; align-items: center; gap: .6rem; width: 100%; text-align: left; border-color: transparent; background: transparent; border-radius: .25rem; padding: .45rem .65rem; }
  .folder-entries button:hover:not(:disabled) { background: #303a42; }
  .folder-entries button svg { color: var(--accent); flex-shrink: 0; }
  .folder-entry-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .folder-empty { padding: 1rem; font-size: .9rem; }
  .picker-status { margin: 0; }
  .picker-name { width: min(100%, 24rem); }
  .picker-actions { display: flex; justify-content: flex-end; gap: .5rem; padding-top: .25rem; }
  @media (min-width: 761px) and (pointer: fine) {
    button, input { min-height: 2.25rem; font-size: .9rem; padding-block: .35rem; }
  }
  @media (max-width: 760px) {
    .picker-intro { font-size: .9rem; }
    .folder-browser { grid-template-columns: minmax(0, 1fr); }
    .folder-places { flex-direction: row; align-items: center; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: .4rem; }
    .folder-places button { flex-shrink: 0; white-space: nowrap; }
    .places-label { display: none; }
    .folder-entries { height: clamp(9rem, 27dvh, 14rem); }
    .picker-actions { justify-content: stretch; }
    .picker-actions button { flex: 1; }
  }
</style>
