<script lang="ts">
  import type { ContentClient, ContentRootSummary, Library } from '@ecs/client';
  import { onDestroy, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import type { FolderContext } from './lib/folder-selection';
  import { createLibraryFolders } from './lib/library-folders';
  import { explain, isForbidden, isUnauthorized } from './lib/problems';
  let { client, context, libraries, invalidation = 0, cached, preferredLibraryId = '', onview }: {
    client: ContentClient; context: FolderContext; libraries: Library[]; invalidation?: number;
    cached?: ContentRootSummary[]; preferredLibraryId?: string;
    onview: (rootId: string, libraryId: string | null) => void;
  } = $props();
  const folders = untrack(() => createLibraryFolders(client, context, { unassigned: true }));
  const contextKey = untrack(() => context.key);
  let roots = $state<ContentRootSummary[]>([]);
  let selected = $state<string[]>([]);
  let selectedLibrary = $state(untrack(() => preferredLibraryId || libraries[0]?.id || ''));
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let linkedLibrary = $state('');
  let disposed = false;
  let generation = 0;
  let lastRequest = '';
  let previousIds = '';
  const live = () => !disposed && context.key === contextKey && (context.isCurrent?.() ?? true);
  $effect(() => {
    const provided = cached;
    const signal = invalidation;
    untrack(() => {
      if (provided) { roots = provided.filter(row => row.root.libraryId === null); return; }
      const request = String(signal); if (lastRequest === request) return;
      lastRequest = request;
      const run = ++generation;
      void client.rootSummaries({ unassigned: true }).then(result => {
        if (live() && run === generation) { roots = result.items; }
      }).catch(error => {
        if (!live() || run !== generation) return;
        failure = explain(error);
        if (isUnauthorized(error) || isForbidden(error)) { roots = []; context.onrejected?.(isUnauthorized(error) ? 401 : 403); }
      });
    });
  });
  $effect(() => {
    const available = roots;
    const options = libraries;
    untrack(() => {
      folders.receive(available);
      const ids = available.map(row => row.root.id);
      if (ids.join(',') !== previousIds) {
        selected = previousIds ? selected.filter(id => ids.includes(id)) : ids;
        previousIds = ids.join(',');
      }
      if (!options.some(library => library.id === selectedLibrary)) selectedLibrary = options[0]?.id ?? '';
    });
  });
  async function link() {
    if (busy || !live() || !selectedLibrary || !selected.length) return;
    busy = true; failure = null;
    const target = selectedLibrary;
    const ids = [...selected];
    try {
      for (const id of ids) {
        if (!live()) return;
        if (!(await folders.assign(id, target))) { failure = 'The folder could not be linked. Refresh and try again.'; return; }
      }
      if (live()) {
        if (Object.keys(get(folders).scanFailures).length) {
          linkedLibrary = target;
          failure = 'Folders linked, but some could not be scanned. Open the library and retry Scan folders for games from Library tools.';
        } else onview('', target);
      }
    } finally { if (!disposed) busy = false; }
  }
  onDestroy(() => { disposed = true; generation++; folders.dispose(); });
</script>
{#if libraries.length && (roots.length || failure || $folders.failure)}
  <section class="existing-folders" aria-label="Existing folders without a library">
    <h2>Use your existing game folders</h2>
    {#if roots.length}
    <p>{roots.length} {roots.length === 1 ? 'folder is' : 'folders are'} already saved on this server but not linked to a library. Add them here instead of selecting the same paths again.</p>
    <div class="existing-folder-list">
      {#each roots as summary (summary.root.id)}<label class="existing-folder-choice">
        <input type="checkbox" checked={selected.includes(summary.root.id)} disabled={busy} onchange={event=>selected=event.currentTarget.checked ? [...selected,summary.root.id] : selected.filter(id=>id!==summary.root.id)} />
        <span><strong>{summary.root.label}</strong><small class="path dim">{summary.root.path}</small></span>
      </label>{/each}
    </div>
    <div class="actions"><label>Add folders to<select bind:value={selectedLibrary} disabled={busy}>{#each libraries as library (library.id)}<option value={library.id}>{library.name}</option>{/each}</select></label>
      <button type="button" class="primary" disabled={busy || !selectedLibrary || !selected.length} onclick={()=>void link()}>{busy ? 'Linking and scanning…' : 'Add selected folders'}</button>
    </div>
    <p class="dim">This scans the folders and applies the selected library’s access permissions. Files stay in place.</p>
    {/if}
    {#if linkedLibrary}<button type="button" onclick={()=>onview('',linkedLibrary)}>Open library</button>{/if}
    {#if failure || $folders.failure}<p class="problem" role="alert">{failure || $folders.failure}</p>{/if}
  </section>
{/if}
<style>
  .existing-folders { border:1px solid var(--line); padding:1rem; margin-block:1rem; }
  .existing-folders h2 { margin-top:0; font-size:1.1rem; }
  .existing-folder-list { max-height:13rem; overflow:auto; margin-block:.6rem; }
  .existing-folder-choice { display:flex; flex-direction:row; align-items:flex-start; gap:.65rem; padding:.45rem 0; }
  .existing-folder-choice input { width:auto; flex:none; margin-top:.25rem; }
  .existing-folder-choice span { min-width:0; }
  .existing-folder-choice small { display:block; }
  .actions { align-items:end; }
  .actions label { min-width:min(14rem,100%); }
</style>
