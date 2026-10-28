<script lang="ts">
  import type { ContentClient, Library } from '@ecs/client';
  import type { FolderContext } from './lib/folder-selection';
  import SettingsLibraries from './SettingsLibraries.svelte';
  import Locations from './Locations.svelte';
  import Tabs from './components/Tabs.svelte';
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
</script>

<header class="page-heading">
  <div><p class="eyebrow">Settings</p><h1>Storage</h1>
    <p class="dim">Choose where games come from and where uploaded copies are saved.</p>
  </div>
</header>
<Tabs {tabs} {selected} onchange={id => selected = id} label="Storage options" idPrefix="storage" panelId="storage-panel" />
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
  .remote-storage { margin-top: 0; }
  .remote-storage p, .remote-storage ol { max-width: var(--content-measure); }
  .remote-storage ol { padding-inline-start: var(--space-6); }
  .remote-storage li { padding: var(--space-1) 0 var(--space-1) var(--space-1); }
</style>
