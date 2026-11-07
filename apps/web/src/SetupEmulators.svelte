<script lang="ts">
  import type { ContentClient } from '@ecs/client';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { createEmulatorSettings } from './lib/emulator-settings';
  import { recommendedEmulators } from './lib/emulator-recommendations';
  import { bytes } from './lib/format';
  import { explain } from './lib/problems';
  let {
    client,
    libraryId,
    onrejected,
    onchange,
    onbusy,
    onmanage,
  }: {
    client: ContentClient;
    libraryId: string;
    onrejected: (status: 401 | 403) => void;
    onchange: () => Promise<void>;
    onbusy: (busy: boolean) => void;
    onmanage: () => void;
  } = $props();
  const emulators = untrack(() => createEmulatorSettings(client, onchange, onrejected));
  let systems = $state<string[]>([]),
    loading = $state(true),
    failure = $state<string | null>(null);
  let disposed = false;
  const recommendations = $derived(
    $emulators.listing
      ? recommendedEmulators({
          ...$emulators.listing,
          available: $emulators.listing.available
            .map((entry) => ({
              ...entry,
              systems: entry.systems.filter((system) => systems.includes(system)),
            }))
            .filter((entry) => entry.systems.length > 0),
        })
      : [],
  );
  const missing = $derived(
    systems.filter(
      (system) =>
        !$emulators.listing?.items.some(
          (item) => item.enabled && item.profile.systems.includes(system),
        ),
    ),
  );
  const download = $derived(
    recommendations.every((entry) => entry.downloadBytes !== null)
      ? recommendations.reduce((total, entry) => total + (entry.downloadBytes ?? 0), 0)
      : null,
  );
  $effect(() => {
    onbusy(loading || $emulators.busy);
  });
  onMount(() => {
    void load();
  });
  onDestroy(() => {
    disposed = true;
    emulators.dispose();
    onbusy(false);
  });
  async function load() {
    loading = true;
    failure = null;
    try {
      const [page] = await Promise.all([
        client.browse({ libraryId, category: 'games', limit: 1 }),
        emulators.load(),
      ]);
      if (!disposed)
        systems = [
          ...new Set(
            page.systemCounts?.map((row) => row.systemId) ??
              page.items.flatMap((item) => (item.systemId ? [item.systemId] : [])),
          ),
        ];
    } catch (error) {
      if (!disposed) failure = explain(error);
    } finally {
      if (!disposed) loading = false;
    }
  }
</script>

<p>
  Emulators let you play games inside the app. We’ll suggest them for the consoles in your library.
</p>
{#if loading}<p role="status">Checking your games and installed emulators…</p>
{:else if $emulators.listing}
  {#if !systems.length}<p>You can choose emulators after adding your games.</p>
  {:else if !missing.length}<p role="status">
      Your installed emulators cover the consoles we found.
    </p>
  {:else if recommendations.length}
    <ul>
      {#each recommendations as emulator (emulator.id)}<li>{emulator.name}</li>{/each}
    </ul>
    <p class="dim">
      {download === null ? 'Download size varies.' : `Download ${bytes(download)}.`} Some consoles also
      need their own system files.
    </p>
    <button
      class="primary"
      type="button"
      disabled={$emulators.busy || $emulators.needsRefresh || $emulators.denied}
      onclick={() => void emulators.installMany(recommendations.map((entry) => entry.id))}
      >Install suggested emulators ({recommendations.length})</button
    >
  {:else}<p>
      Some consoles need additional emulators. You can choose them in Emulators after setup.
    </p>{/if}
{/if}
{#if $emulators.activity}<p role="status">{$emulators.activity}</p>{/if}
{#if $emulators.batch}<ul>
    {#each $emulators.batch.items as item (item.id)}<li>{item.name} · {item.status}</li>{/each}
  </ul>{/if}
{#if failure || $emulators.failure}<p class="problem" role="alert">
    {failure ?? $emulators.failure}
  </p>
  <p>You can continue setup and try this again later.</p>
  <button type="button" disabled={loading || $emulators.busy} onclick={() => void load()}
    >Check again</button
  >{/if}
{#if $emulators.message}<p role="status">{$emulators.message}</p>{/if}
<details class="setup-alternative">
  <summary>Choose emulators yourself</summary>
  <p>See every available emulator and manage system files.</p>
  <button type="button" disabled={loading || $emulators.busy} onclick={onmanage}
    >Open emulators</button
  >
</details>
