<script lang="ts">
  import type { ContentClient, Item, ManifestFile } from '@ecs/client';
  import { bytes } from './lib/format';
  import { explain } from './lib/problems';

  let { client, item }: { client: ContentClient; item: Item } = $props();

  const KIND_ORDER = [
    'rom',
    'battery_save',
    'save_state',
    'screenshot',
    'artwork',
    'bios',
    'system_file',
  ] as const;

  const KIND_LABEL: Record<string, string> = {
    rom: 'ROM',
    battery_save: 'Battery save',
    save_state: 'Save state',
    screenshot: 'Screenshot',
    artwork: 'Artwork',
    bios: 'BIOS',
    system_file: 'System file',
  };

  const SAVE_KINDS = new Set(['battery_save', 'save_state']);

  let files = $state<ManifestFile[]>([]);
  let failure = $state<string | null>(null);
  let reading = $state<{ id: string; received: number; total: number } | null>(null);
  let choosing = $state<string | null>(null);

  const present = $derived(KIND_ORDER.filter((kind) => files.some((file) => file.kind === kind)));

  async function load(): Promise<void> {
    failure = null;
    try {
      files = (await client.manifest(item.id)).files;
    } catch (error) {
      failure = explain(error);
    }
  }

  function ofKind(kind: string): ManifestFile[] {
    return files.filter((file) => file.kind === kind);
  }

  /** Saves that share a path, with the live file first and every copy beside it. */
  function saveGroups(kind: string): Array<{ path: string; live: ManifestFile | null; copies: ManifestFile[] }> {
    const grouped = new Map<string, ManifestFile[]>();
    for (const file of ofKind(kind)) {
      const path = file.relativePath.replace(/\.conflict-[0-9a-f]{8}$/, '');
      const list = grouped.get(path) ?? [];
      list.push(file);
      grouped.set(path, list);
    }
    return [...grouped.entries()].map(([path, group]) => ({
      path,
      live: group.find((file) => !file.conflictOf) ?? null,
      copies: group.filter((file) => file.conflictOf),
    }));
  }

  async function download(file: ManifestFile): Promise<void> {
    failure = null;
    reading = { id: file.id, received: 0, total: file.size };
    try {
      const collected = await client.collect(file.id, {
        onProgress: (received, total) => {
          reading = { id: file.id, received, total: total ?? file.size };
        },
      });
      offer(collected.bytes, file.relativePath.split('/').at(-1) ?? file.relativePath);
    } catch (error) {
      failure = explain(error);
    } finally {
      reading = null;
    }
  }

  /** The chosen copy becomes the live save. The one it replaces stays beside it. */
  async function choose(file: ManifestFile): Promise<void> {
    failure = null;
    choosing = file.id;
    try {
      await client.adopt(file.id);
      await load();
    } catch (error) {
      failure = explain(error);
    } finally {
      choosing = null;
    }
  }

  function offer(content: Uint8Array<ArrayBuffer>, name: string): void {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  void load();
</script>

<section>
  <div class="row">
    <h2>Files in {item.title}</h2>
    <span class="dim">revision {item.revision}</span>
  </div>
  {#if files.length === 0}
    <p class="dim">This item has no files yet.</p>
  {/if}
  {#each present as kind (kind)}
    <h3>{KIND_LABEL[kind] ?? kind}</h3>
    <table>
      <tbody>
        {#if SAVE_KINDS.has(kind)}
          {#each saveGroups(kind) as group (group.path)}
            {#if group.live}
              {@render row(group.live, false)}
            {/if}
            {#each group.copies as copy (copy.id)}
              {@render row(copy, true)}
            {/each}
          {/each}
        {:else}
          {#each ofKind(kind) as file (file.id)}
            {@render row(file, false)}
          {/each}
        {/if}
      </tbody>
    </table>
  {/each}
  {#if failure}
    <p class="problem">{failure}</p>
  {/if}
</section>

{#snippet row(file: ManifestFile, copy: boolean)}
  <tr>
    <td class="path" class:dim={copy}>{file.relativePath}</td>
    <td class="dim">{bytes(file.size)}</td>
    <td>
      {#if reading?.id === file.id}
        <progress max={reading.total} value={reading.received}></progress>
      {:else}
        <button type="button" onclick={() => download(file)} disabled={reading !== null}>
          Download
        </button>
        {#if copy}
          <button type="button" onclick={() => choose(file)} disabled={choosing !== null}>
            {choosing === file.id ? 'Choosing…' : 'Use this one'}
          </button>
        {/if}
      {/if}
    </td>
  </tr>
{/snippet}
