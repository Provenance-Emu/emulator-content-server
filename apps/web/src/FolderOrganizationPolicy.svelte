<script lang="ts">
  import type { ContentClient, ContentRoot, FolderOrganizationPreview, SourceOrganizationPolicy } from '@ecs/client';
  import { onMount, onDestroy } from 'svelte';
  import { explain } from './lib/problems';

  let { client, root, onrejected }: {
    client: ContentClient; root: ContentRoot; onrejected?: (status: 401 | 403) => void;
  } = $props();
  let policy = $state<SourceOrganizationPolicy | null>(null);
  let roots = $state<ContentRoot[]>([]);
  let mode = $state<'move' | 'copy'>('move');
  let targetRootId = $state('');
  let preview = $state<FolderOrganizationPreview | null>(null);
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let disposed = false;
  const targetLabel = $derived(roots.find((folder) => folder.id === targetRootId)?.label ?? root.label);
  onDestroy(() => { disposed = true; });

  async function run(action: () => Promise<void>) {
    if (busy || disposed) return;
    busy = true;
    failure = null;
    try {
      await action();
    } catch (error) {
      if (disposed) return;
      failure = explain(error);
      const status = (error as { status?: number })?.status;
      if (status === 401 || status === 403) {
        policy = null;
        preview = null;
        onrejected?.(status);
      }
    } finally {
      if (!disposed) busy = false;
    }
  }

  function load() {
    return run(async () => {
      const [current, registered] = await Promise.all([
        client.sourceOrganizationPolicy(root.id),
        client.roots(),
      ]);
      if (disposed) return;
      policy = current;
      roots = registered.items.filter((folder) => folder.libraryId === root.libraryId);
      mode = current.mode === 'copy' ? 'copy' : 'move';
      targetRootId = current.targetRootId ?? root.id;
    });
  }

  function prepare() {
    return run(async () => {
      const result = await client.previewFolderOrganization(root.id, { mode, targetRootId });
      if (!disposed) preview = result;
    });
  }

  function setEnabled(enabled: boolean) {
    return run(async () => {
      const planId = preview?.planId;
      if (enabled && !planId) return;
      preview = null;
      const result = await client.setSourceOrganizationPolicy(root.id, { enabled, ...(enabled ? { planId } : {}) });
      if (!disposed) policy = result;
    });
  }

  onMount(() => { void load(); });
</script>

<p><strong>{root.label}</strong></p>
<p class="dim">When you save a system, metadata, or artwork match, ROMs, archives, and complete disc sets can be arranged under <code>System / Game title / Original filename</code>. Existing files stay in place until a match triggers the rule. Multi-disc sets and companion files stay together. Existing destinations are protected from overwrites.</p>
{#if policy}
  {#if policy.enabled}
    <p role="status">Automatic {policy.mode} to {roots.find((folder) => folder.id === policy?.targetRootId)?.label ?? 'the selected folder'} is on.</p>
    <button type="button" disabled={busy} onclick={() => void setEnabled(false)}>Turn off automatic organization</button>
  {:else}
    <p role="status">Automatic organization is off for this folder.</p>
  {/if}

  {#if preview}
    <h3>Organization preview</h3>
    <p>{mode === 'move' ? 'Move originals' : 'Keep originals and create copies'} in <strong>{targetLabel}</strong> when a match is saved.</p>
    {#if preview.examples.length}
      <p class="dim">Examples based on the titles and systems currently indexed. Saving a new match can change the destination.</p>
      <ul class="organization-examples">
        {#each preview.examples as example (example.sourceRelativePath)}
          <li><code>{example.sourceRelativePath}</code> → <code>{example.targetRelativePath}</code></li>
        {/each}
      </ul>
    {:else}
      <p class="dim">There are no eligible files to show from the current index. Example destination <code>NES / Example game / example.nes</code>.</p>
    {/if}
    <div class="actions">
      <button class="primary" type="button" disabled={busy} onclick={() => void setEnabled(true)}>{policy.enabled ? 'Save automatic organization' : 'Enable automatic organization'}</button>
      <button type="button" disabled={busy} onclick={() => { preview = null; }}>Change options</button>
    </div>
  {:else}
    <label>Action
      <select bind:value={mode} disabled={busy}>
        <option value="move">Move the original</option>
        <option value="copy">Copy and keep the original</option>
      </select>
    </label>
    <label>Destination folder
      <select bind:value={targetRootId} disabled={busy}>
        {#each roots as folder (folder.id)}
          <option value={folder.id}>{folder.label}{folder.id === root.id ? ' (this folder)' : ''}</option>
        {/each}
      </select>
    </label>
    <button type="button" disabled={busy || !targetRootId} onclick={() => void prepare()}>Preview automatic organization</button>
  {/if}
{/if}
{#if busy}<p role="status">Updating organization settings…</p>{/if}
{#if failure}
  <p role="alert" class="problem">{failure}</p>
  {#if !policy}<button type="button" disabled={busy} onclick={() => void load()}>Retry organization settings</button>{/if}
{/if}

<style>
  label { margin-block: var(--space-3); }
  .organization-examples { padding-inline-start: var(--space-5); overflow-wrap: anywhere; }
</style>
