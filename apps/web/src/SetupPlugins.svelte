<script lang="ts">
  import type { ContentClient } from '@ecs/client';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { createPluginSettings } from './lib/plugin-settings';
  let {
    client,
    onrejected,
    onbusy,
    onmanage,
  }: {
    client: ContentClient;
    onrejected: (status: 401 | 403) => void;
    onbusy: (busy: boolean) => void;
    onmanage: () => void;
  } = $props();
  const plugins = untrack(() => createPluginSettings(client, onrejected));
  const cleanup = $derived(
    $plugins.listing?.items.find((plugin) => plugin.id === 'org.ecs.library-cleanup'),
  );
  $effect(() => {
    onbusy($plugins.busy);
  });
  onMount(() => {
    void plugins.load();
  });
  onDestroy(() => {
    plugins.dispose();
    onbusy(false);
  });
</script>

<h2>Help organize your games</h2>
<p>
  The Library cleanup helper can find missing artwork and metadata problems. You review its
  suggestions before applying changes.
</p>
{#if cleanup?.enabled}<p role="status">Library cleanup is enabled.</p>
{:else if $plugins.listing?.available}<button
    class="primary"
    type="button"
    disabled={$plugins.busy || $plugins.needsRefresh || $plugins.denied}
    onclick={() => (cleanup ? void plugins.configure(cleanup) : void plugins.installDefaults())}
    >{cleanup ? 'Enable library cleanup' : 'Install library cleanup'}</button
  >
{:else if !$plugins.busy && !$plugins.failure}<p>
    This server needs an update before it can install helpers from the app.
  </p>{/if}
{#if $plugins.busy}<p role="status">Setting up your library helper…</p>{/if}
{#if $plugins.failure}<p class="problem" role="alert">{$plugins.failure}</p>
  <button type="button" disabled={$plugins.busy} onclick={() => void plugins.load()}
    >Check again</button
  >{/if}
{#if $plugins.message}<p role="status">{$plugins.message}</p>{/if}
<p class="dim">
  This step is optional. You can add or manage helpers in Settings → Plugins at any time.
</p>
<details class="setup-alternative">
  <summary>See all plugins and integrations</summary><button
    type="button"
    disabled={$plugins.busy}
    onclick={onmanage}>Open plugins</button
  >
</details>
