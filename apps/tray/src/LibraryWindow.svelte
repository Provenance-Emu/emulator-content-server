<script lang="ts">
  import App from '@ecs/web/App.svelte';
  import { onDestroy } from 'svelte';
  import { folderAdapterFor, managedProfile, nativeFolders, type ManagedEndpoint } from './lib/folders';
  import type { DesktopSelection } from './lib/application';
  import { DEFAULT_ORIGIN } from './lib/watch.svelte';
  import { openExternal } from './lib/windows';
  let { selection }: { selection: DesktopSelection } = $props();
  let typed = $state('');
  let failure = $state<string | null>(null);
  let endpoint = $state<ManagedEndpoint | null>(null);
  let verifying = $state(false);
  let connectionOpen = $state(false);
  let disposed = false;
  const folderSelection = $derived.by(() => { const context = $selection; return context ? folderAdapterFor(selection, endpoint) : undefined; });
  async function selectManaged() {
    if (verifying) return;
    verifying = true; failure = null;
    const context = $selection;
    const result = await nativeFolders.managedEndpoint();
    if (disposed) return;
    verifying = false;
    if ($selection !== context) return;
    endpoint = result;
    if (result.available) { selection.select(managedProfile(result)); connectionOpen = false; }
    else if (context?.profile.profileKey === 'managed-service') {
      // Controllers capture their folder adapter for one context lifetime.
      // Retire that lifetime and staged native paths before exposing the server chooser.
      selection.select({ origin: context.origin, label: context.origin, profileKey: 'manual' });
    }
  }
  $effect(() => { typed = $selection?.origin ?? ''; });
  onDestroy(() => { disposed = true; selection.dispose(); });
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
{#if $selection}<App context={$selection} {folderSelection} />{/if}
{#snippet connectionForm()}
  <form class:connection-first-run={!$selection} onsubmit={(event) => {
    event.preventDefault();
    try {
      selection.select({ origin: typed, label: typed, profileKey: 'manual' });
      endpoint = null; failure = null; connectionOpen = false;
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  }}>
    <button class:primary={!$selection} type="button" disabled={verifying} onclick={() => void selectManaged()}>{verifying ? 'Checking local service…' : 'Use local managed service'}</button>
    <label>Server address <input type="url" bind:value={typed} placeholder={DEFAULT_ORIGIN} required /></label>
    <button class:primary={!!$selection} type="submit">Connect</button>
  </form>
  {#if $selection}<p class="dim">Browser playback may ask you to sign in separately.</p>{/if}
{/snippet}
<style>
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
