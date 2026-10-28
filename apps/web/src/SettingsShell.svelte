<script lang="ts">
  import type { ContentClient, Library } from '@ecs/client';
  import type { FolderContext } from './lib/folder-selection';
  import type { ApplicationState } from './lib/application';
  import SettingsLibraries from './SettingsLibraries.svelte';
  import StorageSettings from './StorageSettings.svelte';
  import Grants from './Grants.svelte';
  import Accounts from './Accounts.svelte';
  import WebDav from './WebDav.svelte';
  import DeviceTokens from './DeviceTokens.svelte';
  import EmulatorSettings from './EmulatorSettings.svelte';
  import Audit from './Audit.svelte';
  import Status from './Status.svelte';
  let {
    client,
    appState,
    onback,
    onview,
    onrejected,
    context, onrename, onplayerschange,
  }: {
    client: ContentClient;
    appState: ApplicationState;
    onback: () => void;
    onrejected: (status: 401 | 403) => void;
    onview: (rootId: string, libraryId: string | null) => void;
    context: FolderContext; onrename: (library: Library) => void;
    onplayerschange?: () => void | Promise<void>;
  } = $props();
  let selected = $state('Libraries');
  let noted = $state(0);
  const sections = ['Libraries', 'Storage', 'Emulators', 'Access', 'Devices', 'WebDAV', 'Activity', 'Server status'];
  const visibleSections = $derived(sections.filter(name => name === 'WebDAV'
    ? appState.capabilities?.features.webdav && appState.hasSession
    : appState.owner || name === 'Server status'));
</script>

<div class="settings-shell compact-controls">
  <nav class="settings-navigation ui-navigation" aria-label="Settings">
    <button type="button" onclick={onback}>Back to library</button>
    {#each visibleSections as name}<button
        type="button"
        aria-current={(visibleSections.includes(selected) ? selected : 'Server status') === name ? 'page' : undefined}
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
      />{:else if appState.owner && selected === 'Storage'}<StorageSettings
        {client}
        libraries={appState.libraries}
        invalidation={appState.invalidation}
        {onview} {onrejected} {context} {onrename}
        onchange={() => noted++}
      />{:else if appState.owner && selected === 'Emulators'}<EmulatorSettings {client} {onrejected} onchange={onplayerschange ?? context.onchanged ?? (() => {})} />{:else if appState.owner && selected === 'Access'}<h1>Access</h1>
      <Accounts {client} libraries={appState.libraries} {onrejected} onchange={context.onchanged ?? (() => {})} />
      <Grants
        {client}
        onchange={() => noted++}
      />{:else if appState.owner && selected === 'Devices'}<DeviceTokens {client} {onrejected} />{:else if selected === 'WebDAV' && visibleSections.includes('WebDAV')}<WebDav {client} origin={context.origin} {onrejected} />{:else if appState.owner && selected === 'Activity'}<h1>Activity</h1>
      <Audit {client} {noted} />{:else}<h1>Server status</h1>
      <Status capabilities={appState.capabilities} reachable={appState.reachable === true} />{/if}
  </div>
</div>
