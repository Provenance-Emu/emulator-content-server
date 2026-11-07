<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import App from '@ecs/web/App.svelte';
  import { get } from 'svelte/store';
  import { connectionAddress } from './lib/application';
  import type { SetupMode } from '../../web/src/lib/setup-progress.js';
  import { onDestroy, untrack } from 'svelte';
  import { folderAdapterFor, managedProfile, nativeFolders, type ManagedEndpoint } from './lib/folders';
  import type { DesktopContext, DesktopSelection } from './lib/application';
  import { DEFAULT_ORIGIN } from './lib/watch.svelte';
  import { openExternal } from './lib/windows';
  let { selection }: { selection: DesktopSelection } = $props();
  const profiles = untrack(() => selection.profiles);
  function skippedGuide() { try { return localStorage.getItem('ecs.tray.setup.skipped') === '1'; } catch { return false; } }
  let welcome = $state(untrack(() => get(selection) === null && !skippedGuide()));
  let remote = $state(false);
  let guideMode = $state<SetupMode | undefined>(undefined);
  let typed = $state('');
  let failure = $state<string | null>(null);
  let endpoint = $state<ManagedEndpoint | null>(null);
  let verifying = $state(false);
  let installing = $state(false);
  let setupCode = $state<{ key: string; value: string } | null>(null);
  let pendingSetupCode: string | undefined;
  const canSetUpMac = '__TAURI_INTERNALS__' in window && /Mac/.test(navigator.platform);
  let connectionOpen = $state(false);
  let disposed = false;
  let verifiedContext = $state.raw<DesktopContext | null>(null);
  let checkingContext: DesktopContext | null = null;
  let verificationGeneration = 0;
  let checkedOnOpen = false;
  const awaitingManagedVerification = $derived(
    $selection?.profile.profileKey === 'managed-service' && $selection !== verifiedContext,
  );
  const folderSelection = $derived.by(() => { const context = $selection; return context ? folderAdapterFor(selection, endpoint) : undefined; });
  function acceptManaged(result: Extract<ManagedEndpoint, { available: true }>) {
    selection.select(managedProfile(result));
    verifiedContext = $selection;
    endpoint = result;
    connectionOpen = false;
    if (pendingSetupCode && result.origin === DEFAULT_ORIGIN && $selection) {
      setupCode = { key: $selection.key, value: pendingSetupCode };
      pendingSetupCode = undefined;
    }
  }
  async function selectManaged(context = $selection, automatic = false) {
    if (verifying && checkingContext === context) return false;
    const run = ++verificationGeneration;
    checkingContext = context;
    verifying = true; failure = null;
    try {
      const result = await nativeFolders.managedEndpoint();
      if (disposed || run !== verificationGeneration || $selection !== context) return;
      if (result.available) {
        // Retire every controller and staged path from the old context before granting an adapter.
        acceptManaged(result);
        return true;
      } else {
        if (!automatic) endpoint = result;
        verifiedContext = null;
        if (context?.profile.profileKey === 'managed-service') {
          selection.select({ origin: context.origin, label: context.origin, profileKey: 'manual' });
        }
      }
    } catch (error) {
      if (!automatic && !disposed && run === verificationGeneration && $selection === context)
        failure = error instanceof Error ? error.message : String(error);
    } finally {
      if (!disposed && run === verificationGeneration) {
        verifying = false;
        checkingContext = null;
      }
    }
    return false;
  }
  async function startHere() {
    guideMode = 'host';
    if (await selectManaged()) { welcome = false; return; }
    if (canSetUpMac && await setUpMac()) welcome = false;
  }
  async function setUpMac() {
    const context = $selection;
    installing = true;
    failure = null;
    try {
      pendingSetupCode = await invoke<string>('install_local_server');
      for (let attempt = 0; attempt < 60 && !disposed && $selection === context; attempt++) {
        const result = await nativeFolders.managedEndpoint();
        if (disposed || $selection !== context) return;
        if (result.available && result.origin === DEFAULT_ORIGIN) {
          acceptManaged(result);
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!disposed && $selection === context)
        failure = 'The local server is still starting. Choose “Use the server on this computer” to check again.';
    } catch (error) {
      if (!disposed && $selection === context)
        failure = error instanceof Error ? error.message : String(error);
    } finally {
      if (!disposed) installing = false;
    }
    return false;
  }
  async function revealSetupCode() {
    const context = $selection;
    const result = await nativeFolders.managedEndpoint();
    if (disposed || !context || $selection !== context ||
      !result.available || new URL(result.origin).origin !== context.origin) {
      throw new Error('The app could not verify the local server. Connect to the local service again.');
    }
    await invoke('reveal_local_setup_code', { verificationId: result.verificationId });
  }
  $effect(() => {
    const context = $selection;
    untrack(() => {
      if (context?.profile.profileKey === 'managed-service') {
        if (context !== verifiedContext) void selectManaged(context);
      } else if (!context && !welcome && !checkedOnOpen && '__TAURI_INTERNALS__' in window) {
        checkedOnOpen = true;
        void selectManaged(context, true);
      } else if (verifying && checkingContext !== context) {
        verificationGeneration++;
        checkingContext = null;
        verifying = false;
      }
    });
  });
  $effect(() => { typed = $selection?.origin ?? ''; });
  onDestroy(() => { disposed = true; verificationGeneration++; selection.dispose(); });
</script>
<header class="desktop-server" class:desktop-connect={!$selection || welcome}>
  {#if welcome}
    <p class="eyebrow">Emulation Server</p>
    {#if remote}
      <h1>Connect to another computer</h1>
      <p class="connection-help">Use the name or address of the computer that keeps your games. Then we’ll help you sign in and choose a library.</p>
      {@render connectionForm()}
      <button type="button" class="text-button" disabled={installing || verifying} onclick={() => remote = false}>Back</button>
    {:else}
      <h1>Let’s set up your game library</h1>
      <p class="connection-help">Where would you like to keep your games?</p>
      <div class="computer-choices">
        <section><h2>On this computer</h2><p>{canSetUpMac ? 'Use a library already installed here, or let the app install one for you.' : 'Use a server already running on this computer.'} We’ll help you add your games next.</p>
          <button class="primary" type="button" disabled={installing || verifying} onclick={() => void startHere()}>{installing ? 'Installing your library…' : verifying ? 'Checking this computer…' : 'Set up this computer'}</button>
        </section>
        <section><h2>On another computer</h2><p>Connect to a library on your Mac, PC or home server.</p><button type="button" disabled={installing || verifying} onclick={() => { remote = true; typed = ''; }}>Connect to another computer</button></section>
      </div>
      {#if $profiles.length}<section class="known-computers"><h2>Your saved computers</h2>{#each $profiles as profile (profile.profileKey + profile.origin)}<button type="button" disabled={installing || verifying} onclick={() => { guideMode = 'join'; selection.select(profile); welcome = false; }}>{profile.label}</button>{/each}</section>{/if}
      {#if !$selection}<button class="text-button" type="button" disabled={installing || verifying} onclick={() => { welcome = false; try { localStorage.setItem('ecs.tray.setup.skipped', '1'); } catch {} }}>Connect without the guide</button>{/if}
      {#if $selection}<button class="text-button" type="button" disabled={installing || verifying} onclick={() => { welcome = false; guideMode = undefined; }}>Back to current library</button>{/if}
    {/if}
  {:else if $selection}
    <div class="connection-summary">
      <p><span class="dim">Server</span> <strong>{$selection.profile.profileKey === 'managed-service' ? 'This computer' : $selection.origin}</strong></p>
      <button type="button" onclick={() => { welcome = true; remote = false; }}>Add another computer</button>
      <button type="button" onclick={() => void openExternal(`${$selection?.origin}/ui/`)}>Open in browser</button>
    </div>
    <details class="connection-details" bind:open={connectionOpen}>
      <summary>Change connection</summary>
      {@render connectionForm()}
    </details>
  {:else}
    <p class="eyebrow">Emulation Server</p>
    <h1>Connect to your game library</h1>
    <p class="connection-help">Start Emulation Server on the computer that holds your games, then connect here. If someone else runs it, ask them for the server address.</p>
    {@render connectionForm()}
    <p class="dim">Use the local service when it is installed on this computer. Otherwise enter the server address, for example http://127.0.0.1:8473.</p>
  {/if}
  {#if endpoint && !endpoint.available}<p role="status" class="dim">{endpoint.reason}</p>{/if}
  {#if failure}<p role="alert" class="problem">{failure}</p>{/if}
</header>
{#if $selection && !welcome}
  {#if awaitingManagedVerification}<p class="startup-verification dim" role="status">Checking local service…</p>
  {:else}<App context={$selection} {folderSelection}
    setupGuide={guideMode} onsetupclose={() => guideMode = undefined} onchoosecomputer={() => { welcome = true; remote = false; }}
    setupCode={setupCode && setupCode.key === $selection.key ? setupCode.value : undefined}
    revealSetupCode={canSetUpMac && ['127.0.0.1', '[::1]'].includes(new URL($selection.origin).hostname) ? revealSetupCode : undefined}
  />{/if}
{/if}
{#snippet connectionForm()}
  <form class:connection-first-run={!$selection} onsubmit={(event) => {
    event.preventDefault();
    try {
      const origin = connectionAddress(typed);
      guideMode = welcome ? 'join' : undefined;
      selection.select({ origin, label: new URL(origin).hostname, profileKey: 'manual' });
      welcome = false;
      verificationGeneration++;
      checkingContext = null;
      verifying = false;
      verifiedContext = null;
      endpoint = null; failure = null; connectionOpen = false;
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  }}>
    <button class:primary={!$selection} type="button" disabled={verifying || installing} onclick={() => void selectManaged()}>{verifying ? 'Checking local service…' : 'Use the server on this computer'}</button>
    <label>{welcome ? 'Computer name or library address' : 'Server address'} <input type="text" bind:value={typed} placeholder="studio.local" required disabled={installing} /></label>
    <button class:primary={!!$selection} type="submit" disabled={installing}>Connect</button>
  </form>
  {#if !welcome && canSetUpMac && $selection?.profile.profileKey !== 'managed-service'}
    <button type="button" disabled={installing || verifying} onclick={() => void setUpMac()}>{installing ? 'Setting up the local server…' : 'Set up this Mac'}</button>
    <p class="dim">Downloads the nightly server and configures it to start at login.</p>
  {/if}
  {#if $selection}<p class="dim">Browser playback may ask you to sign in separately.</p>{/if}
{/snippet}
<style>
  .computer-choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin-block: 1.5rem; }
  .computer-choices section { display: flex; flex-direction: column; align-items: start; padding: 1.25rem; border: 1px solid var(--line); border-radius: .6rem; }
  .computer-choices h2 { font-size: 1.15rem; margin-top: 0; }
  .computer-choices p { flex: 1; margin-bottom: 1rem; }
  .known-computers { margin-block: 1.5rem; }
  .known-computers button { margin: .25rem; }
  .startup-verification { padding: 1rem; }
  .desktop-server { padding: .6rem 1rem; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; }
  .desktop-connect { display: block; max-width: 52rem; margin: 2rem auto; padding: 1.5rem; border: 1px solid var(--line); border-radius: .75rem; }
  .desktop-connect h1 { margin: .5rem 0; }
  .connection-help { max-width: 46rem; line-height: 1.6; }
  .connection-summary { display: flex; flex: 1; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; min-width: 0; }
  .connection-summary p { flex: 1; min-width: 12rem; overflow-wrap: anywhere; }
  .connection-summary strong { margin-left: .5rem; font-weight: 500; }
  .connection-details summary { padding: .6rem .8rem; border: 1px solid var(--line); border-radius: .45rem; cursor: pointer; }
  .connection-details[open] { flex: 1 1 100%; }
  .connection-details[open] summary { width: fit-content; }
  .connection-details form { margin-top: 1rem; }
  .desktop-connect form { margin-block: 1.5rem; }
  .desktop-server form { display: flex; align-items: end; flex-wrap: wrap; gap: .5rem; }
  .desktop-server label { flex: 1; min-width: 14rem; }
  .desktop-server p { margin: .4rem 0 0; }
  .desktop-server > .problem, .desktop-server > [role="status"] { flex-basis: 100%; }
  @media (max-width: 760px) {
    .computer-choices { grid-template-columns: 1fr; }
    .desktop-connect { margin: 1rem; }
    .connection-summary { flex-basis: 100%; }
    .connection-summary p { flex-basis: 100%; }
    .connection-details { width: 100%; }
    .desktop-server label { min-width: 0; flex-basis: 100%; }
  }
</style>
