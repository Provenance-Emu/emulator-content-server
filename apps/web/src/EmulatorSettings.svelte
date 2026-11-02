<script lang="ts">
  import type { ContentClient } from '@ecs/client';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import Tabs from './components/Tabs.svelte';
  import FormField from './components/FormField.svelte';
  import InlineNotice from './components/InlineNotice.svelte';
  import EmulatorSystemFiles from './components/EmulatorSystemFiles.svelte';
  import { createEmulatorSettings } from './lib/emulator-settings';
  import { bytes } from './lib/format';

  let { client, onrejected, onchange = () => {} }: {
    client: ContentClient;
    onrejected: (status: 401 | 403) => void;
    onchange?: () => void | Promise<void>;
  } = $props();
  const emulators = untrack(() => createEmulatorSettings(client, () => onchange(), status => onrejected(status)));
  const tabs = [{ id: 'installed', label: 'Installed' }, { id: 'available', label: 'Available' }];
  let selected = $state('installed');
  let catalogQuery = $state('');
  const catalogEntries = $derived(($emulators.listing?.available ?? []).filter(entry => `${entry.name} ${entry.systems.join(' ')}`.toLowerCase().includes(catalogQuery.trim().toLowerCase())));
  let removing = $state<string | null>(null);
  let packageFile = $state<File | null>(null);
  let packageInput = $state<HTMLInputElement>();
  let disposed = false;
  const locked = $derived($emulators.busy || $emulators.denied || $emulators.needsRefresh);
  const systemNames = (systems: string[]) => systems.map(id => id.startsWith('com.provenance.') ? id.slice(15).toUpperCase() : id).join(', ');

  async function action(event: MouseEvent | SubmitEvent, operation: () => Promise<boolean>) {
    const element = event.currentTarget as HTMLElement;
    await operation();
    if (disposed) return;
    await tick();
    if (disposed) return;
    const button = element instanceof HTMLButtonElement ? element : null;
    const sibling = element.closest('article')?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    const target = button?.isConnected && !button.disabled ? button
      : sibling?.isConnected ? sibling : document.getElementById(`emulators-${selected}`);
    target?.focus();
  }
  async function chooseRemoval(id: string) {
    removing = id;
    await tick();
    if (!disposed) document.getElementById(`confirm-remove-${id}`)?.focus();
  }
  async function cancelRemoval(id: string) {
    removing = null;
    await tick();
    if (!disposed) document.getElementById(`remove-emulator-${id}`)?.focus();
  }
  async function installPackage(event: SubmitEvent) {
    event.preventDefault();
    const file = packageFile;
    if (!file) return;
    await action(event, async () => {
      const saved = await emulators.installPackage(file, file.name);
      if (saved && !disposed) {
        packageFile = null;
        if (packageInput) packageInput.value = '';
        selected = 'installed';
      }
      return saved;
    });
  }
  $effect(() => {
    if ($emulators.denied) { packageFile = null; removing = null; if (packageInput) packageInput.value = ''; }
  });
  onMount(() => { void emulators.load(); });
  onDestroy(() => { disposed = true; packageFile = null; emulators.dispose(); });
</script>

<header class="page-heading emulator-heading">
  <div><p class="eyebrow">Settings</p><h1>Emulators</h1>
    <p class="dim">Choose the emulators available for browser play.</p>
  </div>
  <button type="button" disabled={$emulators.busy} onclick={() => void emulators.load()}>
    {$emulators.failure && !$emulators.listing ? 'Retry emulators' : 'Refresh emulators'}
  </button>
</header>
<p class="dim emulator-intro">Changes apply the next time a game starts. Games already running keep their current emulator.</p>
<Tabs {tabs} {selected} onchange={id => { selected = id; removing = null; }} label="Emulator options" idPrefix="emulators" panelId="emulators-panel" />
{#if $emulators.activity}<InlineNotice kind="status">{$emulators.activity}</InlineNotice>{/if}
{#if $emulators.failure}<InlineNotice kind="error">{$emulators.failure}</InlineNotice>{/if}
{#if $emulators.needsRefresh}<p class="dim">Refresh emulators before making another change.</p>{/if}
{#if $emulators.message}<InlineNotice kind="status">{$emulators.message}</InlineNotice>{/if}
<div id="emulators-panel" role="tabpanel" aria-labelledby={`emulators-${selected}`}>
  {#if $emulators.listing}
    {#if selected === 'installed'}
      <h2>Installed emulators</h2>
      {#if $emulators.listing.items.length === 0}<InlineNotice>No emulators are installed. Open Available to install a supported emulator, or choose a .ecsplayer package below.</InlineNotice>{/if}
      <div class="emulator-list">
        {#each $emulators.listing.items as item (item.profile.id)}
          <article class="emulator-item" aria-labelledby={`emulator-name-${item.profile.id}`}>
            <div class="emulator-item-heading">
              <h3 id={`emulator-name-${item.profile.id}`}>{item.profile.name}</h3>
              <span class="emulator-state">{item.enabled ? 'Enabled' : 'Disabled'}{$emulators.listing.defaultProfileId === item.profile.id ? ' · Default' : ''}</span>
            </div>
            <p class="dim">{systemNames(item.profile.systems)} · Version {item.profile.buildVersion}</p>
            {#if item.source === 'operator'}
              <p class="dim">Installed by the server administrator. Manage this emulator on the server.</p>
            {:else}
              <div class="actions">
                <button type="button" disabled={locked} aria-label={`${item.enabled ? 'Disable' : 'Enable'} ${item.profile.name}`}
                  onclick={event => void action(event, () => emulators.configure(item.profile.id, { enabled: !item.enabled }))}>{item.enabled ? 'Disable' : 'Enable'}</button>
                {#if $emulators.listing.defaultProfileId !== item.profile.id}<button type="button" disabled={locked || !item.enabled}
                    aria-label={`Make ${item.profile.name} default`} onclick={event => void action(event, () => emulators.configure(item.profile.id, { default: true }))}>Make default</button>{/if}
                {#if item.removable && removing !== item.profile.id}<button type="button" id={`remove-emulator-${item.profile.id}`} disabled={locked}
                    aria-label={`Remove ${item.profile.name}`} onclick={() => void chooseRemoval(item.profile.id)}>Remove</button>{/if}
              </div>
              {#if !item.enabled}<p class="dim">Enable this emulator before making it the default.</p>{/if}
              {#if item.removable && removing === item.profile.id}
                <div class="emulator-removal">
                  <p>Remove {item.profile.name}? Your games stay in the library.</p>
                  <div class="actions">
                    <button type="button" disabled={$emulators.busy} onclick={() => void cancelRemoval(item.profile.id)}>Cancel removal</button>
                    <button type="button" id={`confirm-remove-${item.profile.id}`} disabled={locked} aria-label={`Confirm remove ${item.profile.name}`}
                      onclick={event => void action(event, async () => { const saved = await emulators.remove(item.profile.id); if (saved && !disposed) removing = null; return saved; })}>Remove emulator</button>
                  </div>
                </div>
              {/if}
            {/if}
            <EmulatorSystemFiles assets={item.profile.assets} canInstall={item.source === 'managed' && item.profile.runtime !== 'dolphin-wasm-esm'}
              disabled={locked} oninstall={file => emulators.installSystemFile(item.profile.id, file.name, file)} />
          </article>
        {/each}
      </div>
    {:else}
      <h2>Available emulators</h2>
      <p class="dim">Install a supported emulator from the server’s trusted catalog.</p>
      <FormField label="Find an emulator">{#snippet children(attributes)}<input {...attributes} type="search" bind:value={catalogQuery} placeholder="Search name or system" />{/snippet}</FormField>
      <p class="dim" role="status">{catalogEntries.length} emulator{catalogEntries.length === 1 ? '' : 's'} found</p>
      {#if $emulators.listing.available.length === 0}<InlineNotice>No catalog emulators are available on this server. You can install a .ecsplayer package below.</InlineNotice>{/if}
      <div class="emulator-list">
        {#each catalogEntries as entry (entry.id)}
          <article class="emulator-item" aria-labelledby={`available-emulator-${entry.id}`}>
            <div class="emulator-item-heading"><h3 id={`available-emulator-${entry.id}`}>{entry.name}</h3>
              <span class="dim">{systemNames(entry.systems)}</span>
            </div>
            <p>{entry.description}</p>
            {#if $emulators.listing.items.some(item => item.profile.id === entry.id)}<p class="dim">Installed. Manage this emulator under Installed.</p>
            {:else if entry.available}
              {#if entry.downloadBytes !== null}<p class="dim">Download: {bytes(entry.downloadBytes)}</p>{/if}
              <button type="button" disabled={locked} aria-label={`Install ${entry.name}`}
                onclick={event => void action(event, async () => { const saved = await emulators.install(entry.id); if (saved && !disposed) selected = 'installed'; return saved; })}>Install emulator</button>
            {:else}<InlineNotice>{entry.reason || 'This emulator is not available for browser play.'}</InlineNotice>{/if}
          </article>
        {/each}
      </div>
    {/if}
  {/if}
</div>
{#if $emulators.listing && !$emulators.denied}
  <section class="emulator-package" aria-labelledby="emulator-package-heading">
    <h2 id="emulator-package-heading">Install an emulator package</h2>
    <form class="settings-form" onsubmit={event => void installPackage(event)}>
      <FormField label="Emulator package" help="Choose one .ecsplayer file from this device. Selecting a file does not install it.">
        {#snippet children(attributes)}<input {...attributes} bind:this={packageInput} type="file" accept=".ecsplayer" disabled={locked}
            onchange={event => { packageFile = event.currentTarget.files?.[0] ?? null; }} />{/snippet}
      </FormField>
      <button type="submit" disabled={locked || !packageFile}>Install package</button>
    </form>
  </section>
{/if}

<style>
  .emulator-heading { margin-top: 0; margin-bottom: var(--space-3); }
  .emulator-intro { max-width: var(--content-measure); margin-bottom: var(--space-5); }
  .emulator-list { display: grid; gap: var(--space-3); }
  .emulator-item { min-width: 0; padding: var(--panel-padding); border: var(--border-width) solid var(--line); border-radius: var(--radius-panel); background: var(--panel); }
  .emulator-item-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
  .emulator-item h3 { margin: 0; overflow-wrap: anywhere; }
  .emulator-item p { max-width: var(--content-measure); margin: var(--space-2) 0 var(--space-3); }
  .emulator-state { font-size: var(--text-label); color: var(--ink-dim); }
  .emulator-removal { margin-top: var(--space-3); padding: var(--space-3); border: var(--border-width) solid var(--line); border-radius: var(--radius-control); background: var(--color-surface-inset); }
  .emulator-removal p { margin-top: 0; }
  .emulator-package { margin-top: var(--space-5); }
  .emulator-package form { margin-bottom: 0; }
</style>
