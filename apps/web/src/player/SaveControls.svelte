<script lang="ts">
  import { explain } from '../lib/problems';
  import type { SaveKind, SaveSynchronizer } from './saves.js';
  let { saves, hasState, coreName='FCEUmm', supportsSaves=true }: { saves: SaveSynchronizer | null; hasState: boolean; coreName?:string;supportsSaves?:boolean } = $props();
  let working = $state(false);
  let pending = $state<SaveSynchronizer['pending']>(null);
  let failure = $state<string | null>(null);
  let message = $state('');
  let conflict = $state<string | null>(null);
  async function act(operation: () => Promise<unknown>): Promise<void> {
    if (!saves || working) return;
    working = true;
    failure = null;
    message = '';
    try {
      await operation();
      conflict = saves.lastConflict?.relativePath ?? null;
      message = 'Operation completed.';
    } catch (error) { failure = explain(error); }
    finally { pending = saves.pending; working = false; }
  }
  function save(kind: SaveKind): void {
    if (saves) void act(() => saves!.capture(kind));
  }
  function exportSave(): void {
    if (!saves || !pending) return;
    const url = URL.createObjectURL(new Blob([saves.exportPending()], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = pending.relativePath.split('/').at(-1) ?? 'browser-save';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>
<section aria-label="Save synchronization">
  <h2>Saves</h2>
  {#if saves}
    <p class="dim">Saves belong to {coreName} and this profile’s build. Save explicitly before leaving.</p>
    <div class="player-controls">
      <button type="button" disabled={working || pending !== null} onclick={() => save('battery_save')}>Save battery</button>
      <button type="button" disabled={working || pending !== null} onclick={() => save('save_state')}>Save state</button>
      <button type="button" disabled={working || pending !== null || !hasState} onclick={() => act(() => saves!.loadSelectedState())}>Load selected state</button>
    </div>
    {#if pending}
      <p>Unsynced {pending.kind}: {pending.size} bytes, base revision {pending.baseRevision}. These captured bytes stay available while this page is open.</p>
      <div class="player-controls">
        <button type="button" disabled={working} onclick={() => act(() => saves!.retry())}>Retry upload</button>
        <button type="button" onclick={exportSave}>Export captured save</button>
      </div>
    {/if}
    {#if conflict}
      <p role="status">Kept both saves. Browser copy: <code>{conflict}</code>. The gameplay baseline stays unchanged; review copies in the library.</p>
    {/if}
    {#if message}<p role="status">{message}</p>{/if}
    {#if failure}<p role="alert" class="problem">{failure}</p>{/if}
  {:else if !supportsSaves}<p>This emulator profile does not provide save synchronization.</p>
  {:else}
    <p>Playback has no save target. Stop and select an item in the source’s library and system to load or upload saves.</p>
  {/if}
</section>
