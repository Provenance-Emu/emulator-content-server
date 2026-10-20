<script lang="ts">
  import type { ContentClient, Library } from '@ecs/client';
  import type { FolderContext } from './lib/folder-selection';
  import type { ApplicationState } from './lib/application';
  import SettingsLibraries from './SettingsLibraries.svelte';
  import Locations from './Locations.svelte';
  import Grants from './Grants.svelte';
  import Audit from './Audit.svelte';
  import Status from './Status.svelte';
  let {
    client,
    appState,
    onback,
    onview,
    onrejected,
    context, onrename,
  }: {
    client: ContentClient;
    appState: ApplicationState;
    onback: () => void;
    onrejected: (status: 401 | 403) => void;
    onview: (rootId: string, libraryId: string | null) => void;
    context: FolderContext; onrename: (library: Library) => void;
  } = $props();
  let selected = $state('Libraries');
  let noted = $state(0);
  const sections = ['Libraries', 'Upload storage', 'Access', 'Activity', 'Server status'];
</script>

<div class="settings-shell">
  <nav class="settings-navigation" aria-label="Settings">
    <button type="button" onclick={onback}>Back to library</button>
    {#each sections.filter((name) => appState.owner || name === 'Server status') as name}<button
        type="button"
        aria-current={(appState.owner ? selected : 'Server status') === name ? 'page' : undefined}
        onclick={() => (selected = name)}
      >
        {name}
      </button>{/each}
  </nav>
  <div class="settings-content">
    {#if appState.owner && selected === 'Libraries'}<SettingsLibraries
        {client}
        libraries={appState.libraries}
        invalidation={appState.invalidation}
        {onview}
        {onrejected}
        {context} {onrename}
      />{:else if appState.owner && selected === 'Upload storage'}<h1>Upload storage</h1>
      <Locations
        {client}
        {context}
        onchange={() => noted++}
      />{:else if appState.owner && selected === 'Access'}<h1>Access</h1>
      <Grants
        {client}
        onchange={() => noted++}
      />{:else if appState.owner && selected === 'Activity'}<h1>Activity</h1>
      <Audit {client} {noted} />{:else}<h1>Server status</h1>
      <Status capabilities={appState.capabilities} reachable={appState.reachable === true} />{/if}
  </div>
</div>
