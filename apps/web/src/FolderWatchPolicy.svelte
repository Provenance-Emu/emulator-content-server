<script lang="ts">
  import type { ContentClient, ContentRoot, FolderWatchPolicy } from '@ecs/client';
  import { onDestroy, onMount } from 'svelte';
  import { explain } from './lib/problems';
  let { client, root, onrejected }: {
    client: ContentClient; root: ContentRoot; onrejected?: (status: 401 | 403) => void;
  } = $props();
  let policy = $state<FolderWatchPolicy | null>(null);
  let busy = $state(true);
  let failure = $state<string | null>(null);
  let disposed = false;
  let revision = 0;
  const descriptions: Record<FolderWatchPolicy['state'], string> = {
    off: 'Folder watching is off.',
    watching: 'Watching for folder changes.',
    polling: 'Checking periodically for folder changes.',
    offline: 'Folder is offline. Watching will recover when it returns.',
    scanning: 'Refreshing the folder index…',
    error: 'Folder watching needs attention. Recovery checks will retry.',
  };
  function reject(error: unknown) {
    failure = explain(error);
    const status = (error as { status?: number })?.status;
    if (status === 401 || status === 403) { policy = null; onrejected?.(status); }
  }
  async function load() {
    const current = ++revision;
    busy = true; failure = null;
    try { const value = await client.folderWatchPolicy(root.id); if (!disposed && current === revision) policy = value; }
    catch (error) { if (!disposed && current === revision) reject(error); }
    finally { if (!disposed && current === revision) busy = false; }
  }
  async function setEnabled(enabled: boolean) {
    const current = ++revision;
    busy = true; failure = null;
    try { const value = await client.setFolderWatchPolicy(root.id, { enabled }); if (!disposed && current === revision) policy = value; }
    catch (error) { if (!disposed && current === revision) reject(error); }
    finally { if (!disposed && current === revision) busy = false; }
  }
  onMount(() => { void load(); });
  onDestroy(() => { disposed = true; revision++; });
</script>
<p>{root.label}</p>
<p class="dim">Folder watching starts off. Enable it to detect file changes and moves in this registered server folder without a manual scan. Watching updates the index and never moves your files.</p>
<p class="dim">Enable watching on both registered folders in the same library (or both unassigned) for reliable move detection in either direction. Periodic recovery scans catch missed events and provide a fallback when native watching is unavailable.</p>
{#if busy}<p role="status">Updating watching settings…</p>{:else if policy}
  <p role="status">{descriptions[policy.state]}</p>
  {#if policy.lastScanAt}<p class="dim">Last automatic scan: {new Date(policy.lastScanAt).toLocaleString()}</p>{/if}
  {#if policy.warning}<p role="alert" class="problem">{policy.warning}</p>{/if}
  <button type="button" onclick={() => void setEnabled(!policy?.enabled)}>{policy.enabled ? 'Turn off folder watching' : 'Enable folder watching'}</button>
{/if}
{#if failure}<p role="alert" class="problem">{failure}</p>{/if}
<button type="button" disabled={busy} onclick={() => void load()}>Refresh watching status</button>
