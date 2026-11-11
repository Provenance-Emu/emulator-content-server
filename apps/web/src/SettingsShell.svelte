<script lang="ts">
  import type { ContentClient, Library } from '@ecs/client';
  import type { FolderContext } from './lib/folder-selection';
  import type { ApplicationState } from './lib/application';
  import { documentationLinks } from './lib/documentation';
  import type { ServerUpdatesView } from './lib/server-updates';
  import { settingsSections, type SettingsSection } from './lib/shell-navigation';
  import SettingsLibraries from './SettingsLibraries.svelte';
  import ScansAndDetails from './ScansAndDetails.svelte';
  import type { ServerContext } from './lib/application';
  import StorageSettings from './StorageSettings.svelte';
  import Grants from './Grants.svelte';
  import Accounts from './Accounts.svelte';
  import WebDav from './WebDav.svelte';
  import DeviceTokens from './DeviceTokens.svelte';
  import PluginSettings from './PluginSettings.svelte';
  import EmulatorSettings from './EmulatorSettings.svelte';
  import Audit from './Audit.svelte';
  import Status from './Status.svelte';
  import ServerUpdateSettings from './ServerUpdateSettings.svelte';

  let {
    client, appState, updates, onback, onview, onrejected, context, server,
    pairingPin = '', onpaired = () => {},
    serverLabel = 'Emulation Server',
    onrename, onplayerschange, onsignin = () => {}, onsetup, onopendocumentation,
    selected = $bindable<SettingsSection>('libraries'),
    libraryId = $bindable(''),
    onselect = () => {},
    onlibrarychange = () => {},
  }: {
    client: ContentClient;
    pairingPin?: string;
    onpaired?: () => void;
    serverLabel?: string;
    appState: ApplicationState;
    updates?: ServerUpdatesView;
    onback: () => void;
    onrejected: (status: 401 | 403) => void;
    onview: (rootId: string, libraryId: string | null) => void;
    context: FolderContext;
    server?: ServerContext;
    onrename: (library: Library) => void;
    onplayerschange?: () => void | Promise<void>;
    onsignin?: () => void;
    onsetup?: () => void;
    onopendocumentation?: (href: string) => void;
    selected?: SettingsSection;
    libraryId?: string;
    onselect?: () => void;
    onlibrarychange?: () => void;
  } = $props();
  let noted = $state(0);
  const visibleSections = $derived(settingsSections.filter(section =>
    section.id === 'webdav'
      ? appState.capabilities?.features.webdav && appState.hasSession
      : section.id === 'updates' ? appState.owner && appState.hasSession && updates
      : appState.owner || section.id === 'status',
  ));
  const active = $derived(visibleSections.some(section => section.id === selected) ? selected : 'status');
  function choose(value: string) {
    const section = visibleSections.find(section => section.id === value);
    if (!section) return;
    selected = section.id;
    onselect();
  }
  function openDocumentation(event: MouseEvent & { currentTarget: HTMLAnchorElement }) {
    if (!onopendocumentation) return;
    event.preventDefault();
    onopendocumentation(event.currentTarget.href);
  }
</script>

<div class="settings-shell compact-controls">
  <aside class="settings-sidebar">
    <button class="settings-back" type="button" onclick={onback}>Back to library</button>
    {#if onsetup}<button type="button" class="settings-back" onclick={onsetup}>Setup guide</button>{/if}
    <p class="settings-server-identity eyebrow">{serverLabel}</p>
    <p class="settings-heading">Settings</p>
    <label class="settings-section-picker">
      Settings section
      <select value={active} onchange={event => choose(event.currentTarget.value)}>
        {#each visibleSections as section}<option value={section.id}>{section.label}</option>{/each}
      </select>
    </label>
    <nav class="settings-navigation ui-navigation" aria-label="Settings">
      {#each ['Collection', 'Sharing', 'Server'] as group}
        {@const sections = visibleSections.filter(section => section.group === group)}
        {#if sections.length}<div class="settings-navigation-group">
          <p class="nav-label">{group}</p>
          {#each sections as section}<button
            type="button"
            aria-current={active === section.id ? 'page' : undefined}
            onclick={() => choose(section.id)}
          >{section.label}</button>{/each}
        </div>{/if}
      {/each}
    </nav>
  </aside>
  <div class="settings-content">
    {#if appState.owner && !appState.hasSession && ['emulators', 'plugins'].includes(active)}
      <h1>{active === 'plugins' ? 'Plugins' : 'Emulators'}</h1>
      <p>Sign in with your owner account to install or manage {active === 'plugins' ? 'library helpers' : 'emulators'}.</p>
      <button type="button" class="primary" onclick={onsignin}>Sign in to continue</button>
    {:else if appState.owner && active === 'libraries'}<SettingsLibraries
      {client} libraries={appState.libraries} invalidation={appState.invalidation}
      {onview} {onrejected} {context} {onrename}
      bind:libraryId onlibrarychange={onlibrarychange}
    />{:else if appState.owner && active === 'scans' && server}<ScansAndDetails
      context={server} libraries={appState.libraries} {onrejected}
      onchanged={() => void context.onchanged?.()}
    />{:else if appState.owner && active === 'storage'}<StorageSettings
      {client} {context} onchange={() => noted++}
      onmanagefolders={() => choose('libraries')}
    />{:else if appState.owner && active === 'emulators'}<EmulatorSettings
      {client} {onrejected} onchange={onplayerschange ?? context.onchanged ?? (() => {})}
    />{:else if appState.owner && active === 'plugins'}<PluginSettings {client} {onrejected} onemulators={() => choose('emulators')} />
    {:else if appState.owner && active === 'access'}
      <h1>Access</h1>
      <Accounts {client} libraries={appState.libraries} {onrejected} onchange={context.onchanged ?? (() => {})} />
      <Grants {client} onchange={() => noted++} />
    {:else if appState.owner && active === 'devices'}<DeviceTokens {client} {onrejected} {pairingPin} {onpaired} />
    {:else if active === 'webdav'}<WebDav {client} origin={context.origin} {onrejected} />
    {:else if appState.owner && active === 'activity'}
      <h1>Activity</h1>
      <Audit {client} {noted} />
    {:else if updates && active === 'updates'}<ServerUpdateSettings {updates} />
    {:else}
      <h1>Server status</h1>
      <Status capabilities={appState.capabilities} reachable={appState.reachable === true} />
      <section aria-labelledby="api-reference-heading">
        <h2 id="api-reference-heading">API and documentation</h2>
        <p class="dim">Explore the REST API for this server or read the project guides.</p>
        <ul>
          {#each documentationLinks(context.origin) as { href, label } (href)}
            <li><a {href} target="_blank" rel="noreferrer" onclick={openDocumentation}>{label}</a></li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
</div>
