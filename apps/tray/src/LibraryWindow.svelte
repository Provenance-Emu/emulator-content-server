<script lang="ts">
  import App from '@ecs/web/App.svelte';
  import { onDestroy } from 'svelte';
  import type { DesktopSelection } from './lib/application';
  import { DEFAULT_ORIGIN } from './lib/watch.svelte';
  import { openExternal } from './lib/windows';
  let { selection }: { selection: DesktopSelection } = $props();
  let typed = $state('');
  let failure = $state<string | null>(null);
  $effect(() => { typed = $selection?.origin ?? ''; });
  onDestroy(() => selection.dispose());
</script>
<header class="desktop-server">
  <form onsubmit={(event) => {
    event.preventDefault();
    try { selection.select({ origin: typed, label: typed, profileKey: 'manual' }); failure = null; }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
  }}>
    <label>Server address <input type="url" bind:value={typed} placeholder={DEFAULT_ORIGIN} required /></label>
    <button type="submit">Connect</button>
    {#if $selection}<button type="button" onclick={() => void openExternal(`${$selection?.origin}/ui/`)}>Open in browser</button>{/if}
  </form>
  {#if failure}<p role="alert" class="problem">{failure}</p>{/if}
  <p class="dim">{$selection ? `Browsing ${$selection.origin}. Browser playback may ask you to sign in separately.` : 'Choose the content server to browse.'}</p>
</header>
{#if $selection}<App context={$selection} />{/if}
<style>
  .desktop-server { padding: .6rem 1rem; border-bottom: 1px solid var(--line); }
  .desktop-server form { display: flex; align-items: end; flex-wrap: wrap; gap: .5rem; }
  .desktop-server label { flex: 1; min-width: 14rem; }
  .desktop-server p { margin: .4rem 0 0; }
</style>
