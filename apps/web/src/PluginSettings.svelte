<script lang="ts">
  import type { ContentClient } from '@ecs/client';
  import { onDestroy, onMount, untrack } from 'svelte';
  import InlineNotice from './components/InlineNotice.svelte';
  import { createPluginSettings } from './lib/plugin-settings';
  let { client, onrejected, onemulators }: {
    client: ContentClient;
    onrejected: (status: 401 | 403) => void;
    onemulators: () => void;
  } = $props();
  const plugins = untrack(() => createPluginSettings(client, onrejected));
  const locked = $derived($plugins.busy || $plugins.denied || $plugins.needsRefresh);
  const otherHosts = $derived($plugins.hosts.filter(host => host.id !== $plugins.listing?.hostId));
  onMount(() => { void plugins.load(); });
  onDestroy(() => plugins.dispose());
  const PROVIDES: Record<string, string> = {
    rom: 'system',
    metadata: 'game details',
    artwork: 'artwork',
    patch: 'patches',
    cheats: 'cheats',
  };
  /** Says what a source supplies, in the page's own words. */
  function provides(capabilities: string[]) {
    const named = capabilities.map((capability) => PROVIDES[capability] ?? capability).join(', ');
    return named ? `Provides ${named}` : 'Nothing to offer yet';
  }
</script>

<header class="page-heading">
  <div><p class="eyebrow">Settings</p><h1>Plugins</h1>
    <p class="dim">Plugins add tools to your library, such as cleanup. This page shows what is installed and where game details can come from.</p>
  </div>
  <button type="button" disabled={$plugins.busy} onclick={() => void plugins.load()}>Refresh plugins</button>
</header>
{#if $plugins.busy}<InlineNotice kind="status">Checking plugins and applying your changes…</InlineNotice>{/if}
{#if $plugins.failure}<InlineNotice kind="error">{$plugins.failure}</InlineNotice>{/if}
{#if $plugins.needsRefresh}<p>Refresh plugins to check the result before trying another change.</p>{/if}
{#if $plugins.message}<InlineNotice kind="status">{$plugins.message}</InlineNotice>{/if}
{#if $plugins.listing}
  {#if !$plugins.listing.available}
    <InlineNotice>This server was installed without plugins. Update Emulation Server, then refresh this page.</InlineNotice>
  {:else}
    <section aria-labelledby="plugin-host-heading">
      <h2 id="plugin-host-heading">Plugin service</h2>
      <p>{$plugins.listing.running ? 'Running on this server' : $plugins.listing.hostId ? 'Stopped' : 'Not set up yet'}</p>
      {#if $plugins.listing.error}<InlineNotice kind="error">{$plugins.listing.error}</InlineNotice>{/if}
      <button type="button" disabled={locked} onclick={() => void plugins.doctor()}>Check and repair connection</button>
      <p class="dim">Checks what is installed and reconnects the plugin service. Plugins that are on start again when the server restarts.</p>
    </section>
    <section aria-labelledby="plugin-defaults-heading">
      <h2 id="plugin-defaults-heading">Included plugins</h2>
      <div class="plugin-list">
        {#each $plugins.listing.defaults as plugin (plugin.id)}
          <article aria-labelledby={`available-${plugin.id}`}>
            <h3 id={`available-${plugin.id}`}>{plugin.name}</h3>
            <p>{plugin.description}</p>
            <p class="dim">Version {plugin.version} · Included with Emulation Server</p>
          </article>
        {/each}
      </div>
      <button class="primary" type="button" disabled={locked} onclick={() => void plugins.installDefaults()}>
        {$plugins.listing.items.some(item => $plugins.listing?.defaults.some(plugin => plugin.id === item.id)) ? 'Update bundled plugins' : 'Install bundled plugins'}
      </button>
      <p class="dim">Installs the included plugins and turns them on.</p>
    </section>
    <section aria-labelledby="installed-plugins-heading">
      <h2 id="installed-plugins-heading">Installed plugins</h2>
      {#if !$plugins.listing.items.length}<p>No plugins installed yet.</p>{/if}
      <div class="plugin-list">
        {#each $plugins.listing.items as plugin (plugin.id + plugin.digest)}
          <article aria-labelledby={`installed-${plugin.id}-${plugin.digest}`}>
            <h3 id={`installed-${plugin.id}-${plugin.digest}`}>{plugin.name}</h3>
            <p>{plugin.enabled ? 'Enabled' : 'Disabled'} · Version {plugin.version}</p>
            <details><summary>Details</summary><p class="dim plugin-id">{plugin.id} · {plugin.digest.slice(0, 12)}</p></details>
            <button type="button" disabled={locked} aria-label={`${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name} ${plugin.version}`}
              onclick={() => void plugins.configure(plugin)}>{plugin.enabled ? 'Disable' : 'Enable'}</button>
          </article>
        {/each}
      </div>
    </section>
  {/if}
  <section aria-labelledby="metadata-plugins-heading">
    <h2 id="metadata-plugins-heading">Where game details come from</h2>
    {#if $plugins.integrationsFailure}<InlineNotice kind="error">{$plugins.integrationsFailure}</InlineNotice>{/if}
    <div class="plugin-list">
      {#each $plugins.providers as plugin (plugin.id)}
        <article aria-labelledby={`metadata-${plugin.id}`}>
          <h3 id={`metadata-${plugin.id}`}>{plugin.name}</h3>
          <p>{plugin.network ? 'Online' : 'On this server'} · {provides(plugin.capabilities)}</p>
          <details><summary>Details</summary><p class="dim plugin-id">{plugin.id}</p></details>
        </article>
      {/each}
    </div>
    <p class="dim">You choose which of these to use when you look up a game or review a cleanup.</p>
  </section>
  {#if otherHosts.length}
    <section aria-labelledby="other-plugin-hosts-heading">
      <h2 id="other-plugin-hosts-heading">Plugin services on other computers</h2>
      <div class="plugin-list">
        {#each otherHosts as host (host.id)}
          <article><h3>{host.name}</h3>
            <p>{host.enrolled ? 'Connected' : 'Waiting to connect'}{host.lastSeenAt ? ` · Last connected ${new Date(host.lastSeenAt).toLocaleString()}` : ''}</p>
            <ul>{#each host.packages ?? [] as plugin (plugin.id)}<li>{plugin.name} · {plugin.version}</li>{/each}</ul>
          </article>
        {/each}
      </div>
    </section>
  {/if}
{/if}
<section aria-labelledby="plugin-emulators-heading">
  <h2 id="plugin-emulators-heading">Browser emulators</h2>
  <p>Emulators for playing in the browser are managed in Emulators.</p>
  <button type="button" onclick={onemulators}>Manage emulators</button>
</section>

<style>
  section { margin-block: 1.5rem; }
  .plugin-list { display: grid; gap: .75rem; margin-block: .75rem; }
  article { border: 1px solid var(--border, #7775); border-radius: .5rem; padding: 1rem; }
  article h3 { margin-top: 0; }
  .plugin-id { overflow-wrap: anywhere; }
</style>
