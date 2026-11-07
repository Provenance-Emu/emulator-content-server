<script lang="ts">
  import type { ContentClient } from '@ecs/client';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import Tabs from './components/Tabs.svelte';
  import FormField from './components/FormField.svelte';
  import InlineNotice from './components/InlineNotice.svelte';
  import EmulatorSystemFiles from './components/EmulatorSystemFiles.svelte';
  import { createEmulatorSettings } from './lib/emulator-settings';
  import { recommendedEmulators } from './lib/emulator-recommendations';
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
  let installSelection = $state<string[]>([]);
  let removeSelection = $state<string[]>([]);
  let reviewingRecommended = $state(false);
  let confirmingBulkRemoval = $state(false);
  const installable = $derived(($emulators.listing?.available ?? []).filter(entry => entry.available && !$emulators.listing?.items.some(item => item.profile.id === entry.id)));
  const visibleInstallable = $derived(installable.filter(entry => catalogEntries.some(visible => visible.id === entry.id)));
  const removable = $derived(($emulators.listing?.items ?? []).filter(item => item.source === 'managed' && item.removable));
  const selectedInstalls = $derived(installable.filter(entry => installSelection.includes(entry.id)));
  const selectedRemovals = $derived(removable.filter(item => removeSelection.includes(item.profile.id)));
  const recommended = $derived($emulators.listing ? recommendedEmulators($emulators.listing) : []);
  const recommendedBytes = $derived(recommended.reduce((total, entry) => total + (entry.downloadBytes ?? 0), 0));
  const unknownRecommendedDownloads = $derived(recommended.filter(entry => entry.downloadBytes === null).length);
  const downloadBytes = $derived(selectedInstalls.reduce((total, entry) => total + (entry.downloadBytes ?? 0), 0));
  const unknownDownloads = $derived(selectedInstalls.filter(entry => entry.downloadBytes === null).length);
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
    target?.focus({ preventScroll: true });
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
      }
      return saved;
    });
  }
  function toggleSelection(ids: string[], id: string, checked: boolean) {
    return checked ? [...new Set([...ids, id])] : ids.filter(value => value !== id);
  }
  async function reviewRecommended() {
    installSelection = recommended.map(entry => entry.id);
    reviewingRecommended = true;
    await tick();
    if (!disposed) document.getElementById('emulator-install-review')?.focus({ preventScroll: true });
  }
  async function reviewRemoval() {
    confirmingBulkRemoval = true;
    await tick();
    if (!disposed) document.getElementById('confirm-bulk-removal')?.focus({ preventScroll: true });
  }
  async function removeSelected() {
    const saved = await emulators.removeMany(selectedRemovals.map(item => item.profile.id));
    if (!disposed) confirmingBulkRemoval = false;
    return saved;
  }
  $effect(() => {
    if ($emulators.listing && !$emulators.busy) {
      const validInstalls = installSelection.filter(id => installable.some(entry => entry.id === id));
      const validRemovals = removeSelection.filter(id => removable.some(item => item.profile.id === id));
      if (validInstalls.length !== installSelection.length) installSelection = validInstalls;
      if (validRemovals.length !== removeSelection.length) removeSelection = validRemovals;
    }
  });
  $effect(() => {
    if ($emulators.denied) { packageFile = null; removing = null; installSelection = []; removeSelection = []; confirmingBulkRemoval = false; reviewingRecommended = false; if (packageInput) packageInput.value = ''; }
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
{#if $emulators.batch && !$emulators.denied}
  <section class="emulator-batch" aria-labelledby="emulator-batch-heading">
    <h2 id="emulator-batch-heading">{$emulators.batch.operation === 'install' ? 'Installation' : 'Removal'} progress</h2>
    {#if $emulators.busy}<p class="dim">Up to three requests run at a time. Stopping lets active requests finish.</p>
      <button type="button" disabled={$emulators.batch.stopped} onclick={() => emulators.stopBatch()}>{$emulators.batch.stopped ? 'Stopping queued work…' : 'Stop queued work'}</button>{/if}
    <ul class="emulator-results">
      {#each $emulators.batch.items as item (item.id)}
        <li>
          <strong>{item.name}</strong> — {item.status}
          {#if item.detail}<span class="dim"> · {item.detail}</span>{/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
<div id="emulators-panel" role="tabpanel" aria-labelledby={`emulators-${selected}`}>
  {#if $emulators.listing}
    {#if selected === 'installed'}
      <h2>Installed emulators</h2>
      {#if removable.length > 0}
        <div class="emulator-bulk actions" aria-label="Bulk removal actions">
          <button type="button" disabled={locked} onclick={() => { removeSelection = removable.map(item => item.profile.id); }}>Select all removable</button>
          <button type="button" disabled={locked || removeSelection.length === 0} onclick={() => { removeSelection = []; confirmingBulkRemoval = false; }}>Clear removal selection</button>
          <button type="button" disabled={locked || selectedRemovals.length === 0} onclick={() => void reviewRemoval()}>Remove selected ({selectedRemovals.length})</button>
        </div>
        {#if confirmingBulkRemoval}
          <div class="emulator-removal">
            <p>Remove {selectedRemovals.length} selected emulator{selectedRemovals.length === 1 ? '' : 's'} and their installed system files? Your games stay in the library.</p>
            <ul>{#each selectedRemovals as item (item.profile.id)}<li>{item.profile.name}</li>{/each}</ul>
            <div class="actions"><button type="button" disabled={$emulators.busy} onclick={() => { confirmingBulkRemoval = false; }}>Cancel bulk removal</button>
              <button id="confirm-bulk-removal" type="button" disabled={locked || selectedRemovals.length === 0} onclick={event => void action(event, removeSelected)}>Confirm remove {selectedRemovals.length} emulators</button></div>
          </div>
        {/if}
      {/if}
      {#if $emulators.listing.items.length === 0}<InlineNotice>No emulators are installed. Open Available to install a supported emulator, or choose a .ecsplayer package below.</InlineNotice>{/if}
      <div class="emulator-list">
        {#each $emulators.listing.items as item (item.profile.id)}
          <article class="emulator-item" aria-labelledby={`emulator-name-${item.profile.id}`}>
            <div class="emulator-item-heading">
              <h3 id={`emulator-name-${item.profile.id}`}>{item.profile.name}</h3>
              {#if item.source === 'managed' && item.removable}
                <label class="emulator-selection">
                  <input type="checkbox" disabled={locked} checked={removeSelection.includes(item.profile.id)}
                    onchange={event => {
                      removeSelection = toggleSelection(removeSelection, item.profile.id, event.currentTarget.checked);
                      confirmingBulkRemoval = false;
                    }} />
                  Select {item.profile.name} for removal
                </label>
              {/if}
              <span class="emulator-state">{item.enabled ? 'Enabled' : 'Disabled'}{$emulators.listing.defaultProfileId === item.profile.id ? ' · Default' : ''}</span>
            </div>
            <p class="dim">{systemNames(item.profile.systems)} · Version {item.profile.buildVersion}</p>
            <p class="dim">Formats {item.profile.contentExtensions.map(extension => `.${extension}`).join(', ')} · Up to {bytes(item.profile.maxContentBytes)} per game</p>
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
                  <p>Remove {item.profile.name} and its installed system files? Your games stay in the library.</p>
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
      <section class="emulator-recommendations" aria-labelledby="emulator-recommendations-heading">
        <h3 id="emulator-recommendations-heading">Recommended set</h3>
        <p class="dim">Fill missing system coverage with a curated set of browser emulators.</p>
        <p class="dim">The first fallback may download up to 1.6 GB of reviewed archives to prepare the local cache. Later installs reuse cached files.</p>
        <p class="dim">{recommended.length} additional emulator{recommended.length === 1 ? '' : 's'} recommended across the server catalog · Download {bytes(recommendedBytes)}{unknownRecommendedDownloads > 0 ? ` plus ${unknownRecommendedDownloads} with unknown size` : ''}.</p>
        <div class="actions">
          <button type="button" disabled={locked || recommended.length === 0} onclick={event => void action(event, () => emulators.installMany(recommended.map(entry => entry.id)))}>Install recommended ({recommended.length})</button>
          <button type="button" disabled={locked || recommended.length === 0} onclick={() => void reviewRecommended()}>Review recommended set</button>
        </div>
      </section>
      <FormField label="Find an emulator">{#snippet children(attributes)}<input {...attributes} type="search" bind:value={catalogQuery} placeholder="Search name or system" />{/snippet}</FormField>
      <div class="emulator-bulk actions" aria-label="Bulk installation actions">
        <button type="button" disabled={locked || visibleInstallable.length === 0} onclick={() => { installSelection = [...new Set([...installSelection, ...visibleInstallable.map(entry => entry.id)])]; reviewingRecommended = false; }}>Select visible installable</button>
        <button type="button" disabled={locked || installSelection.length === 0} onclick={() => { installSelection = []; reviewingRecommended = false; }}>Clear installation selection</button>
      </div>
      {#if selectedInstalls.length > 0}
        <section class="emulator-install-review" aria-labelledby="emulator-install-review">
          <h3 id="emulator-install-review" tabindex="-1">{reviewingRecommended ? 'Review recommended installation' : 'Selected installation'} · {selectedInstalls.length} emulators</h3>
          <p class="dim">Download {bytes(downloadBytes)}{unknownDownloads > 0 ? ` plus ${unknownDownloads} download${unknownDownloads === 1 ? '' : 's'} with unknown size` : ''}. Some systems require separately supplied system files.</p>
          <ul>
            {#each selectedInstalls as entry (entry.id)}
              <li>
                <label class="emulator-selection">
                  <input type="checkbox" checked disabled={locked} aria-label={`Include ${entry.name} in installation`}
                    onchange={event => { installSelection = toggleSelection(installSelection, entry.id, event.currentTarget.checked); }} />
                  {entry.name} · {systemNames(entry.systems)}
                </label>
              </li>
            {/each}
          </ul>
          <button type="button" disabled={locked} onclick={event => void action(event, () => emulators.installMany(selectedInstalls.map(entry => entry.id)))}>Install selected emulators ({selectedInstalls.length})</button>
        </section>
      {/if}
      <p class="dim" role="status">{catalogEntries.length} emulator{catalogEntries.length === 1 ? '' : 's'} found</p>
      {#if $emulators.listing.available.length === 0}<InlineNotice>No catalog emulators are available on this server. You can install a .ecsplayer package below.</InlineNotice>{/if}
      <div class="emulator-list">
        {#each catalogEntries as entry (entry.id)}
          <article class="emulator-item" aria-labelledby={`available-emulator-${entry.id}`}>
            <div class="emulator-item-heading"><h3 id={`available-emulator-${entry.id}`}>{entry.name}</h3>
              {#if entry.available && !$emulators.listing.items.some(item => item.profile.id === entry.id)}
                <label class="emulator-selection">
                  <input type="checkbox" disabled={locked} checked={installSelection.includes(entry.id)}
                    onchange={event => { installSelection = toggleSelection(installSelection, entry.id, event.currentTarget.checked); }} />
                  Select {entry.name} for installation
                </label>
              {/if}
              <span class="dim">{systemNames(entry.systems)}</span>
            </div>
            <p>{entry.description}</p>
            {#if $emulators.listing.items.some(item => item.profile.id === entry.id)}<p class="dim">Installed. Manage this emulator under Installed.</p>
            {:else if entry.available}
              {#if entry.downloadBytes !== null}<p class="dim">Download: {bytes(entry.downloadBytes)}</p>{/if}
              <button type="button" disabled={locked} aria-label={`Install ${entry.name}`}
                onclick={event => void action(event, () => emulators.install(entry.id))}>Install emulator</button>
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
  .emulator-bulk { margin: var(--space-3) 0; }
  .emulator-recommendations, .emulator-install-review, .emulator-batch { margin: var(--space-3) 0; padding: var(--panel-padding); border: var(--border-width) solid var(--line); border-radius: var(--radius-panel); background: var(--panel); }
  .emulator-selection { display: inline-flex; align-items: center; gap: var(--space-2); min-height: var(--control-height); font-size: var(--text-label); }
  .emulator-selection input { width: 1.1em; height: 1.1em; flex-shrink: 0; }
  .emulator-install-review ul, .emulator-results { padding-left: var(--space-5); }
  .emulator-results li { overflow-wrap: anywhere; margin: var(--space-2) 0; }
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
