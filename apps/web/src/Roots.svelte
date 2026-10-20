<script lang="ts">
  import type { ContentClient, ContentRoot, SourceFile, PlayerCoreDescriptor } from '@ecs/client';
  import { onMount, untrack } from 'svelte';
  import FolderPicker from './FolderPicker.svelte';
  import { explain } from './lib/problems';
  import { sourcePlayHref } from './player/links';

  let { client, roots }: { client: ContentClient; roots: ContentRoot[] } = $props();

  const KIND_LABEL: Record<string, string> = {
    rom: 'ROM',
    battery_save: 'Battery save',
    save_state: 'Save state',
    screenshot: 'Screenshot',
    artwork: 'Artwork',
    bios: 'BIOS',
    system_file: 'System file',
  };

  const AVAILABILITY: Record<string, string> = {
    local: 'On this machine',
    evicted: 'Not downloaded',
    offline: 'Disk offline',
  };

  let saved = $state(untrack(() => roots));
  let playerCore = $state<PlayerCoreDescriptor | null>(null);
  let files = $state<SourceFile[]>([]);
  let scanned = $state(false);
  let path = $state('');
  let label = $state('');
  let picking = $state(false);
  let working = $state(false);
  let failure = $state<string | null>(null);

  const grouped = $derived.by(() => {
    const systems = new Map<string, Map<string, SourceFile[]>>();
    for (const file of files) {
      const system = systemLabel(file.systemId);
      const kinds = systems.get(system) ?? new Map<string, SourceFile[]>();
      const list = kinds.get(file.kind) ?? [];
      list.push(file);
      kinds.set(file.kind, list);
      systems.set(system, kinds);
    }
    return [...systems.entries()].sort(([left], [right]) => left.localeCompare(right));
  });

  function systemLabel(id: string | null): string {
    if (!id) return 'Unknown system';
    const prefix = 'com.provenance.';
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
  }

  function choose(chosen: string): void {
    path = chosen;
    picking = false;
    if (!label.trim()) label = chosen.split('/').filter(Boolean).at(-1) ?? chosen;
  }

  async function load(list: ContentRoot[]): Promise<void> {
    for (const root of list) await client.scanRoot(root.id);
    files = (await client.sources()).items;
    scanned = true;
  }

  async function add(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    working = true;
    failure = null;
    try {
      await client.addRoot({ path: path.trim(), label: label.trim() });
      path = '';
      label = '';
      saved = (await client.roots()).items;
      await load(saved);
    } catch (error) {
      failure = explain(error);
    } finally {
      working = false;
    }
  }

  async function remove(id: string): Promise<void> {
    failure = null;
    try {
      await client.removeRoot(id);
      saved = saved.filter((root) => root.id !== id);
      files = (await client.sources()).items;
    } catch (error) {
      failure = explain(error);
    }
  }

  async function rescan(): Promise<void> {
    working = true;
    failure = null;
    try {
      await load(saved);
    } catch (error) {
      failure = explain(error);
    } finally {
      working = false;
    }
  }

  onMount(() => {
    void client.capabilities().then(async (capabilities) => {
      if (capabilities.features.webPlayback) playerCore = await client.playerCore();
    }).catch(() => {});
    void load(roots).catch((error: unknown) => { failure = explain(error); });
  });
</script>

<section>
  <h2>Content folders</h2>
  {#if saved.length === 0}
    <p class="dim">No folders are registered. Nothing is scanned until one is.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Label</th><th>Folder</th><th></th></tr>
      </thead>
      <tbody>
        {#each saved as root (root.id)}
          <tr>
            <td>{root.label}</td>
            <td class="path dim">{root.path}</td>
            <td><button type="button" onclick={() => remove(root.id)}>Remove</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p><button type="button" onclick={rescan} disabled={working}>Scan again</button></p>
  {/if}
  {#if files.length > 0}
    <h2>Files in those folders</h2>
    {#each grouped as [system, kinds] (system)}
      <h3>{system}</h3>
      {#each [...kinds.entries()] as [kind, entries] (kind)}
        <h4>{KIND_LABEL[kind] ?? kind}</h4>
        <table>
          <tbody>
            {#each entries as file (file.id)}
              {@const play = sourcePlayHref(playerCore, file)}
              <tr>
                <td>{file.name}</td>
                <td>
                  {#if play}<a href={play}>Play</a>{/if}
                </td>
                <td class="dim">{AVAILABILITY[file.availability] ?? file.availability}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/each}
    {/each}
  {:else if scanned && saved.length > 0}
    <p class="dim">This folder has no files yet.</p>
  {/if}
  {#if picking}
    <FolderPicker {client} onchoose={choose} oncancel={() => (picking = false)} />
  {/if}
  <form onsubmit={add}>
    <label>
      Folder on the server
      <input bind:value={path} placeholder="/Volumes/Games/NES" size="28" required />
    </label>
    <label>
      Label
      <input bind:value={label} placeholder="NES shelf" required />
    </label>
    <button type="button" onclick={() => (picking = !picking)}>
      {picking ? 'Hide browser' : 'Browse'}
    </button>
    <button type="submit" disabled={working}>Add folder</button>
  </form>
  {#if failure}
    <p class="problem">{failure}</p>
  {/if}
</section>
