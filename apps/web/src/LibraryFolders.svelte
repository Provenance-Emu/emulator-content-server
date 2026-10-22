<script lang="ts">
  import type { ContentClient, ContentRoot, ContentRootSummary, Library } from '@ecs/client';
  import { get } from 'svelte/store';
  import { onDestroy, tick, untrack } from 'svelte';
  import { createLibraryFolders } from './lib/library-folders';
  import { chooseFolder, type FolderContext } from './lib/folder-selection';
  import { explain } from './lib/problems';
  import FolderOrganizationPolicy from './FolderOrganizationPolicy.svelte';
  import FolderSummaryRows from './components/FolderSummaryRows.svelte';
  import Modal from './components/Modal.svelte';
  import FolderPicker from './FolderPicker.svelte';
  let { client, context, library, libraries, summaries, onview }: {
    client: ContentClient; context: FolderContext; library?: Library; libraries: Library[];
    summaries: ContentRootSummary[]; onview: (rootId: string, libraryId: string | null) => void;
  } = $props();
  const folders = untrack(() => createLibraryFolders(client, context, library ? { libraryId: library.id } : { unassigned: true }));
  let picking = $state(false);
  let pickerBusy = $state(false);
  let choosing = $state(false);
  let failure = $state<string | null>(null);
  let policyRoot = $state<ContentRoot | null>(null);
  let disconnect = $state<ContentRoot | null>(null);
  let assignment = $state<ContentRoot | null>(null);
  let libraryId = $state('');
  let disposed = false;
  let addButton = $state<HTMLButtonElement>();
  async function closePicker() { picking = false; await tick(); if (!disposed) addButton?.focus(); }
  $effect(() => { const cached = summaries; untrack(() => folders.receive(cached)); });
  async function choose() {
    if (!context.folderSelection) { picking = true; return; }
    if (choosing) return;
    choosing = true; failure = null;
    try { const selected = await chooseFolder(context, 'library-folder'); if (selected && !disposed) await folders.add(selected); }
    catch (error) { if (!disposed) failure = explain(error); }
    finally { if (!disposed) choosing = false; }
  }
  onDestroy(() => { disposed = true; folders.dispose(); });
</script>
{#if library}<div class="actions">
  <button bind:this={addButton} type="button" disabled={$folders.busy || choosing || $folders.denied} aria-label={`Add folder to ${library.name}`} onclick={() => void choose()}>Add folder</button>
  <button type="button" disabled={$folders.busy || $folders.denied || !$folders.summaries.length} aria-label={`Scan ${library.name}`} onclick={() => void folders.scanLibrary()}>Scan library</button>
</div>{/if}
<FolderSummaryRows summaries={$folders.summaries} scanFailures={$folders.scanFailures} busy={$folders.busy} {onview}
  onorganization={root=>policyRoot=root}
  onscan={(id) => void folders.retryScan(id)} onremove={(root) => (disconnect = root)} onassign={(root) => { assignment = root; libraryId = ''; }} />
{#if $folders.failure || failure}<p class="problem" role="alert">{$folders.failure || failure}</p>{/if}
{#if $folders.denied}<button type="button" disabled={$folders.busy} onclick={() => void folders.load(library ? { libraryId: library.id } : { unassigned: true })}>Retry folder access</button>{/if}
{#if picking}<Modal title="Add library folder" busy={pickerBusy || $folders.busy} onclose={() => void closePicker()}>
  <FolderPicker {client} contextKey={context.key} origin={context.origin} title="Add library folder" submitLabel="Add folder" onbusy={(busy) => (pickerBusy = busy)} oncancel={() => void closePicker()}
    onsubmit={async (selection) => { const saved = await folders.add(selection); if (!saved) throw new Error(get(folders).failure ?? 'Folder could not be added.'); return saved; }} />
</Modal>{/if}
{#if disconnect}<Modal title="Disconnect folder" busy={$folders.busy} onclose={() => (disconnect = null)}>
  <p>Disconnect {disconnect.label} from this library?</p>
  <p>Files stay on disk.</p>
  <button type="button" disabled={$folders.busy} onclick={() => (disconnect = null)}>Cancel</button>
  <button type="button" disabled={$folders.busy} onclick={async () => { if (disconnect && await folders.remove(disconnect.id)) disconnect = null; }}>Disconnect folder</button>
  {#if $folders.failure}<p class="problem" role="alert">{$folders.failure}</p>{/if}
</Modal>{/if}
{#if assignment}<Modal title="Assign folder" busy={$folders.busy} onclose={() => (assignment = null)}>
  <p>Assigning {assignment.label} applies the selected library permissions to its files. Files stay in place.</p>
  <label>Library<select bind:value={libraryId} disabled={$folders.busy}><option value="">Choose a library</option>{#each libraries as item (item.id)}<option value={item.id}>{item.name}</option>{/each}</select></label>
  <button type="button" disabled={$folders.busy} onclick={() => (assignment = null)}>Cancel</button>
  <button type="button" disabled={$folders.busy || !libraryId} onclick={async () => { if (assignment && await folders.assign(assignment.id, libraryId)) assignment = null; }}>Assign folder</button>
  {#if $folders.failure}<p class="problem" role="alert">{$folders.failure}</p>{/if}
</Modal>{/if}

{#if policyRoot}<Modal title="Automatic organization" onclose={()=>policyRoot=null}>
  {#key policyRoot.id}<FolderOrganizationPolicy {client} root={policyRoot} onrejected={context.onrejected} />{/key}
</Modal>{/if}
