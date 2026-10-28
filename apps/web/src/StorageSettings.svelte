<script lang="ts">
  import type { ContentClient, Library } from '@ecs/client';
  import type { FolderContext } from './lib/folder-selection';
  import SettingsLibraries from './SettingsLibraries.svelte';
  import Locations from './Locations.svelte';
  let {
    client, libraries, invalidation, onview, onrejected, context, onrename, onchange = () => {},
  }: {
    client: ContentClient;
    libraries: Library[];
    invalidation: number;
    onview: (rootId: string, libraryId: string | null) => void;
    onrejected: (status: 401 | 403) => void;
    context: FolderContext;
    onrename: (library: Library) => void;
    onchange?: () => void;
  } = $props();
  const tabs = [
    { id: 'folders', label: 'Folders on server' },
    { id: 'uploads', label: 'Uploaded files' },
    { id: 'remote', label: 'Remote storage' },
  ];
  let selected = $state('folders');
  function navigate(event: KeyboardEvent, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const tab = tabs[next];
    if (tab) selected = tab.id;
    (event.currentTarget as HTMLElement).parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
</script>

<header class="page-heading">
  <div><p class="eyebrow">Settings</p><h1>Storage</h1>
    <p class="dim">Choose where games come from and where uploaded copies are saved.</p>
  </div>
</header>
<div class="category-tabs storage-tabs" role="tablist" aria-label="Storage options">
  {#each tabs as tab, index}
    <button type="button" role="tab" id={`storage-${tab.id}`} aria-controls="storage-panel"
      aria-selected={selected === tab.id} tabindex={selected === tab.id ? 0 : -1}
      onclick={() => selected = tab.id} onkeydown={event => navigate(event, index)}>{tab.label}</button>
  {/each}
</div>
<div id="storage-panel" role="tabpanel" aria-labelledby={`storage-${selected}`}>
  {#if selected === 'folders'}
    <SettingsLibraries {client} {libraries} {invalidation} {onview} {onrejected} {context} {onrename} mode="folders" />
  {:else if selected === 'uploads'}
    <Locations {client} {context} {onchange} />
  {:else}
    <section aria-labelledby="remote-storage-heading" class="remote-storage">
      <h2 id="remote-storage-heading">Use a mounted network or cloud folder</h2>
      <p>Emulation Server reads remote storage through folders mounted on the server computer.</p>
      <ol>
        <li>Connect the network drive or cloud storage folder using that computer’s operating system.</li>
        <li>Add the mounted folder to a library under Folders on server.</li>
        <li>Keep the drive connected and its files available to Emulation Server.</li>
      </ol>
      <button type="button" onclick={() => { selected = 'folders'; document.getElementById('storage-folders')?.focus(); }}>Manage server folders</button>
      <p class="dim">To save newly uploaded copies on a mounted drive, choose a destination under Uploaded files.</p>
    </section>
  {/if}
</div>
<style>
  .page-heading { margin-top: 0; }
  .storage-tabs { gap: .25rem; }
  .remote-storage { margin-top: 0; }
  .remote-storage p, .remote-storage ol { max-width: 62ch; }
  .remote-storage ol { padding-inline-start: 1.4rem; }
  .remote-storage li { padding: .35rem 0 .35rem .25rem; }
</style>
