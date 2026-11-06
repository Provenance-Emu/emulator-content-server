<script lang="ts">
  import type { ContentClient } from '@ecs/client';
  import type { FolderContext } from './lib/folder-selection';
  import Locations from './Locations.svelte';
  import Tabs from './components/Tabs.svelte';
  let {
    client, context, onchange = () => {}, onmanagefolders = () => {},
  }: {
    client: ContentClient;
    context: FolderContext;
    onchange?: () => void;
    onmanagefolders?: () => void;
  } = $props();
  const tabs = [
    { id: 'uploads', label: 'Upload destinations' },
    { id: 'remote', label: 'Network and cloud folders' },
  ];
  let selected = $state('uploads');
</script>

<header class="page-heading">
  <div>
    <p class="eyebrow">Settings</p>
    <h1>Storage</h1>
    <p class="dim">Choose where uploaded copies are saved. Manage existing game folders in Libraries.</p>
  </div>
  <button type="button" onclick={onmanagefolders}>Manage library folders</button>
</header>
<Tabs {tabs} {selected} onchange={id => selected = id} label="Storage options" idPrefix="storage" panelId="storage-panel" />
<div id="storage-panel" role="tabpanel" aria-labelledby={`storage-${selected}`}>
  {#if selected === 'uploads'}<Locations {client} {context} {onchange} />
  {:else}<section aria-labelledby="remote-storage-heading" class="remote-storage">
    <h2 id="remote-storage-heading">Use a mounted network or cloud folder</h2>
    <p>Emulation Server reads remote storage through folders mounted on the server computer.</p>
    <ol>
      <li>Connect the network drive or cloud storage folder using that computer’s operating system.</li>
      <li>Add the mounted folder to a library.</li>
      <li>Keep the drive connected and its files available to Emulation Server.</li>
    </ol>
    <button type="button" onclick={onmanagefolders}>Manage library folders</button>
  </section>{/if}
</div>
