<script lang="ts">
  import type { ContentClient, Item, ManifestFile } from '@ecs/client';
  import { bytes } from './lib/format';
  import { explain } from './lib/problems';

  let { client, item }: { client: ContentClient; item: Item } = $props();

  let files = $state<ManifestFile[]>([]);
  let failure = $state<string | null>(null);
  /** The asset being read and how much of it has arrived, for one progress bar. */
  let reading = $state<{ id: string; received: number; total: number } | null>(null);

  async function load(): Promise<void> {
    failure = null;
    try {
      files = (await client.manifest(item.id)).files;
    } catch (error) {
      failure = explain(error);
    }
  }

  async function save(file: ManifestFile): Promise<void> {
    failure = null;
    reading = { id: file.id, received: 0, total: file.size };
    try {
      // A stream that breaks resumes from what arrived, so a large file does
      // not start over on a flaky connection.
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

  /** Hands the bytes to the browser's own download, which is the only component here allowed near a disk. */
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
  {:else}
    <table>
      <thead>
        <tr><th>Path</th><th>Kind</th><th>Size</th><th></th></tr>
      </thead>
      <tbody>
        {#each files as file (file.id)}
          <tr>
            <td class="path">{file.relativePath}</td>
            <td class="dim">{file.kind}</td>
            <td class="dim">{bytes(file.size)}</td>
            <td>
              {#if reading && reading.id === file.id}
                <progress max={reading.total} value={reading.received}></progress>
              {:else}
                <button type="button" onclick={() => save(file)} disabled={reading !== null}>
                  Download
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  {#if failure}
    <p class="problem">{failure}</p>
  {/if}
</section>
