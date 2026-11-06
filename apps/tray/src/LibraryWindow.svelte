<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import App from '@ecs/web/App.svelte';
  import { onDestroy, untrack } from 'svelte';
  import { folderAdapterFor, managedProfile, nativeFolders, type ManagedEndpoint } from './lib/folders';
  import type { DesktopContext, DesktopSelection } from './lib/application';
  import { DEFAULT_ORIGIN } from './lib/watch.svelte';
  import { openExternal } from './lib/windows';
  let { selection }: { selection: DesktopSelection } = $props();
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
    if (verifying && checkingContext === context) return;
    const run = ++verificationGeneration;
    checkingContext = context;
    verifying = true; failure = null;
    try {
      const result = await nativeFolders.managedEndpoint();
      if (disposed || run !== verificationGeneration || $selection !== context) return;
      if (result.available) {
        // Retire every controller and staged path from the old context before granting an adapter.
        acceptManaged(result);
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
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!disposed && $selection === context)
        failure = 'The local server is still starting. Use local managed service to check again.';
    } catch (error) {
      if (!disposed && $selection === context)
        failure = error instanceof Error ? error.message : String(error);
    } finally {
      if (!disposed) installing = false;
    }
  }
  $effect(() => {
    const context = $selection;
    untrack(() => {
      if (context?.profile.profileKey === 'managed-service') {
        if (context !== verifiedContext) void selectManaged(context);
      } else if (!context && !checkedOnOpen && '__TAURI_INTERNALS__' in window) {
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
<header class="desktop-server" class:desktop-connect={!$selection}>
  {#if $selection}
    <div class="connection-summary">
      <p><span class="dim">Server</span> <strong>{$selection.profile.profileKey === 'managed-service' ? 'This computer' : $selection.origin}</strong></p>
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
{#if $selection}
  {#if awaitingManagedVerification}<p class="startup-verification dim" role="status">Checking local service…</p>
  {:else}<App context={$selection} {folderSelection}
    setupCode={setupCode && setupCode.key === $selection.key ? setupCode.value : undefined}
  />{/if}
{/if}
{#snippet connectionForm()}
  <form class:connection-first-run={!$selection} onsubmit={(event) => {
    event.preventDefault();
    try {
      selection.select({ origin: typed, label: typed, profileKey: 'manual' });
      verificationGeneration++;
      checkingContext = null;
      verifying = false;
      verifiedContext = null;
      endpoint = null; failure = null; connectionOpen = false;
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  }}>
    <button class:primary={!$selection} type="button" disabled={verifying || installing} onclick={() => void selectManaged()}>{verifying ? 'Checking local service…' : 'Use local managed service'}</button>
    <label>Server address <input type="url" bind:value={typed} placeholder={DEFAULT_ORIGIN} required disabled={installing} /></label>
    <button class:primary={!!$selection} type="submit" disabled={installing}>Connect</button>
  </form>
  {#if canSetUpMac && $selection?.profile.profileKey !== 'managed-service'}
    <button type="button" disabled={installing || verifying} onclick={() => void setUpMac()}>{installing ? 'Setting up the local server…' : 'Set up this Mac'}</button>
    <p class="dim">Downloads the nightly server and configures it to start at login.</p>
  {/if}
  {#if $selection}<p class="dim">Browser playback may ask you to sign in separately.</p>{/if}
{/snippet}
<style>
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
    .desktop-connect { margin: 1rem; }
    .connection-summary { flex-basis: 100%; }
    .connection-summary p { flex-basis: 100%; }
    .connection-details { width: 100%; }
    .desktop-server label { min-width: 0; flex-basis: 100%; }
  }
</style>
