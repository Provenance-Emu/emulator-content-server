<script lang="ts">
  import type { ContentClient, Library } from '@ecs/client';
  import { get } from 'svelte/store';
  import { onDestroy, untrack } from 'svelte';
  import { createLibraryEditor } from './lib/library-editor';
  import { chooseFolder, type FolderContext } from './lib/folder-selection';
  import { explain, isForbidden, isUnauthorized } from './lib/problems';
  import FolderPicker from './FolderPicker.svelte';
  import Modal from './components/Modal.svelte';
  let { client, context, library, oncomplete, onclose }: {
    client: ContentClient; context: FolderContext; library?: Library;
    oncomplete: (id: string) => void | Promise<void>; onclose: () => void;
  } = $props();
  const editor = untrack(() => createLibraryEditor(client, context, library));
  let picking = $state(false);
  let pickerBusy = $state(false);
  let choosing = $state(false);
  let failure = $state<string | null>(null);
  let existing = $state<Library[]>([]);
  let selected = $state('');
  let refreshing = $state(false);
  let disposed = false;
  const title = $derived(library ? 'Rename library' : 'Create library');
  async function choose() {
    failure = null;
    if (!context.folderSelection) { picking = true; return; }
    if (choosing) return;
    choosing = true;
    try { const selected = await chooseFolder(context, 'library-folder'); if (selected && !disposed) await editor.stageFolder(selected); }
    catch (error) { if (!disposed) failure = explain(error); }
    finally { if (!disposed) choosing = false; }
  }
  async function submit() {
    if (await editor.submit()) {
      const id = get(editor).libraryId;
      if (id && !disposed) await oncomplete(id);
    }
  }
  async function refreshExisting() {
    if (refreshing || disposed || !(context.isCurrent?.() ?? true)) return;
    refreshing = true;
    try {
      const result = await client.browseLibraries();
      if (!disposed && (context.isCurrent?.() ?? true)) existing = result.items;
    } catch (error) {
      if (!disposed && (context.isCurrent?.() ?? true)) {
        failure = explain(error);
        if (isUnauthorized(error) || isForbidden(error)) {
          existing = []; selected = '';
          context.onrejected?.(isUnauthorized(error) ? 401 : 403);
        }
      }
    } finally { if (!disposed) refreshing = false; }
  }
  onDestroy(() => { disposed = true; editor.dispose(); });
</script>
<Modal {title} busy={$editor.busy || pickerBusy || choosing} {onclose}>
  <label>Library name<input value={$editor.name} maxlength="80" disabled={$editor.busy || (!!$editor.libraryId && !library)} oninput={(event) => editor.setName(event.currentTarget.value)} /></label>
  {#if !library}<p class="dim">Give your collection a name, such as “My games” or “Family favorites”. Create it now and add games next. If your games are already on the server computer, you can optionally select that folder here; the files stay where they are.</p>
    <ul>{#each $editor.folders as folder, index (folder.selection.path)}<li>
      <span class="path">{folder.selection.path}</span>
      {#if folder.scanned}<span> Scanned</span>{:else if folder.rootId}<span> Folder saved</span>{/if}
      {#if folder.failure}<p class="problem" role="alert">{folder.failure}</p>{/if}
      {#if !$editor.libraryId}<button type="button" disabled={$editor.busy} aria-label={`Remove staged folder ${folder.selection.path}`} onclick={() => editor.removeStagedFolder(index)}>Remove</button>{/if}
    </li>{/each}</ul>
    {#if !$editor.libraryId && !$editor.reconciliationRequired}<button type="button" disabled={$editor.busy || choosing} onclick={() => void choose()}>Select server folder</button>{/if}
  {/if}
  {#if picking}<FolderPicker {client} contextKey={context.key} origin={context.origin} title="Select server folder" submitLabel="Select folder" onsubmit={(selection) => editor.stageFolder(selection)} onbusy={(busy) => (pickerBusy = busy)} oncancel={() => (picking = false)} />{/if}
  {#if $editor.reconciliationRequired}<p role="alert">The library may have been created. Refresh and select the existing library before continuing. No library will be selected by name.</p>
    <button type="button" disabled={$editor.busy || refreshing} onclick={() => void refreshExisting()}>Refresh existing libraries</button>
    <label>Existing library<select bind:value={selected} disabled={$editor.busy}><option value="">Choose the library that was created</option>{#each existing as item (item.id)}<option value={item.id}>{item.name} ({item.id})</option>{/each}</select></label>
    <button type="button" disabled={!selected || $editor.busy} onclick={() => void editor.reconcileCreatedLibrary(selected)}>Continue with selected library</button>
  {/if}
  {#if $editor.failure || failure}<p class="problem" role="alert">{$editor.failure || failure}</p>{/if}
  <div class="actions"><button type="button" disabled={$editor.busy || pickerBusy || choosing} onclick={onclose}>Cancel</button>
    <button class="primary" type="button" disabled={$editor.busy || pickerBusy || choosing || picking || $editor.reconciliationRequired || !$editor.name.trim()} onclick={() => void submit()}>{library ? 'Save name' : $editor.libraryId ? 'Retry remaining steps' : 'Create library'}</button>
  </div>
</Modal>
