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
    if (result.available) selection.select(managedProfile(result));
    else if (context?.profile.profileKey === 'managed-service') {
      // Controllers capture their folder adapter for one context lifetime.
      // Retire that lifetime and staged native paths before exposing the server chooser.
      selection.select({ origin: context.origin, label: context.origin, profileKey: 'manual' });
    }
  }
  $effect(() => { typed = $selection?.origin ?? ''; });
  onDestroy(() => { disposed = true; selection.dispose(); });
</script>
<header class="desktop-server">
  <form onsubmit={(event) => {
    event.preventDefault();
    try { selection.select({ origin: typed, label: typed, profileKey: 'manual' }); endpoint = null; failure = null; }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
  }}>
    <label>Server address <input type="url" bind:value={typed} placeholder={DEFAULT_ORIGIN} required /></label>
    <button type="submit">Connect</button>
    <button type="button" disabled={verifying} onclick={() => void selectManaged()}>{verifying ? 'Checking local service…' : 'Use local managed service'}</button>
    {#if $selection}<button type="button" onclick={() => void openExternal(`${$selection?.origin}/ui/`)}>Open in browser</button>{/if}
  </form>
  {#if endpoint && !endpoint.available}<p role="status" class="dim">{endpoint.reason}</p>{/if}
  {#if failure}<p role="alert" class="problem">{failure}</p>{/if}
  <p class="dim">{$selection ? `Browsing ${$selection.origin}. Browser playback may ask you to sign in separately.` : 'Choose the content server to browse.'}</p>
</header>
{#if $selection}<App context={$selection} {folderSelection} />{/if}
<style>
  .desktop-server { padding: .6rem 1rem; border-bottom: 1px solid var(--line); }
  .desktop-server form { display: flex; align-items: end; flex-wrap: wrap; gap: .5rem; }
  .desktop-server label { flex: 1; min-width: 14rem; }
  .desktop-server p { margin: .4rem 0 0; }
</style>
