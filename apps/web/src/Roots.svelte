<script lang="ts">
  import type { ContentClient, ContentRoot } from '@ecs/client';
  import FolderPicker from './FolderPicker.svelte';
  import { explain } from './lib/problems';

  let { client, roots }: { client: ContentClient; roots: ContentRoot[] } = $props();

  let saved = $state(roots);
  let path = $state('');
  let label = $state('');
  let picking = $state(false);
  let working = $state(false);
  let failure = $state<string | null>(null);

  function choose(chosen: string): void {
    path = chosen;
    picking = false;
    // The last segment is almost always the name a person would have typed.
    if (!label.trim()) label = chosen.split('/').filter(Boolean).at(-1) ?? chosen;
  }

  async function add(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    working = true;
    failure = null;
    try {
      // The path is text the server resolves. This page never reads a disk, so
      // the server stays the only component that decides what a folder means.
      await client.addRoot({ path: path.trim(), label: label.trim() });
      path = '';
      label = '';
      saved = (await client.roots()).items;
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
    } catch (error) {
      failure = explain(error);
    }
  }
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
