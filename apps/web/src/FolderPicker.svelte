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
<section aria-label={title} class="picker">
  <p class="dim">Choose a folder on the computer running Emulation Server. Files stay in that folder; we scan it to find your games. To copy files from this device instead, close this window and choose Upload files.</p>
  <form onsubmit={submit}>
    <label>Server folder path<input bind:value={path} required disabled={busy} placeholder="/Volumes/Games" oninput={() => { generation++; reading = false; }} /></label>
    <button type="button" disabled={busy || reading || !path.trim()} onclick={() => void open(path.trim())}>Browse path</button>
    <label>Folder name (optional)<input bind:value={name} maxlength="80" disabled={busy} placeholder="Uses the folder name" /></label>
    {#if listing}
      <div class="places">{#each listing.places as place (place.path)}<button type="button" disabled={busy || reading} onclick={() => void open(place.path)}>{place.label}</button>{/each}</div>
      <button type="button" disabled={busy || reading || !listing.parent} onclick={() => void open(listing?.parent ?? null)}>Up</button>
      <ul class="folders">{#each listing.entries as entry (entry.path)}<li><button type="button" disabled={busy || reading} onclick={() => void open(entry.path)}>{entry.name}</button></li>{:else}<li class="dim">No folders inside this one.</li>{/each}</ul>
    {/if}
    {#if reading}<p role="status">Reading folders on the server…</p>{/if}
    {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
    <div class="actions"><button type="button" disabled={busy} onclick={oncancel}>Cancel</button><button type="submit" disabled={busy || !path.trim()}>{busy ? 'Working…' : submitLabel}</button></div>
  </form>
</section>
<style>
  .places { display: flex; gap: .4rem; flex-wrap: wrap; }
  .folders { list-style: none; padding: 0; max-height: 13rem; overflow-y: auto; }
  .folders li { border-top: 1px solid var(--line); }
  .folders button { width: 100%; text-align: left; }
</style>
