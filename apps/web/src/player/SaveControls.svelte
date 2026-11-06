<script lang="ts">
  import { explain } from '../lib/problems';
  import { downloadBytes } from './downloads.js';
  import { pngInfo } from './images.js';
  import type { PlayerRuntime } from './runtime.js';
  import type { SaveKind, SaveSynchronizer } from './saves.js';

  let {
    saves, runtime, hasState, coreName = 'FCEUmm', supportsSaves = true,
    captureReady = false, disabled = false, refresh = 0, showQuickActions = true,
    onchange = () => {}, onbusy = () => {},
  }: {
    saves: SaveSynchronizer | null;
    runtime: PlayerRuntime;
    hasState: boolean;
    coreName?: string;
    supportsSaves?: boolean;
    captureReady?: boolean;
    disabled?: boolean;
    refresh?: number;
    showQuickActions?: boolean;
    onchange?: () => void;
    onbusy?: (busy: boolean) => void;
  } = $props();
  let working = $state(false);
  let failure = $state<string | null>(null);
  let message = $state('');
  let conflict = $state<string | null>(null);
  let screenshot = $state.raw<Uint8Array<ArrayBuffer> | null>(null);
  const pending = $derived.by(() => { refresh; return saves?.pending ?? null; });
  const blocked = $derived(working || disabled || pending !== null);

  async function act(operation: () => Promise<unknown>) {
    if (blocked) return;
    working = true;
    onbusy(true);
    failure = null;
    message = '';
    try {
      await operation();
      conflict = saves?.lastConflict?.relativePath ?? null;
      message = saves?.previewWarning ?? 'Operation completed.';
    } catch (error) {
      failure = explain(error);
    } finally {
      working = false;
      onbusy(false);
      onchange();
    }
  }

  export function save(kind: SaveKind) {
    if (saves) void act(() => saves.capture(kind));
  }

  export function capture() {
    if (!captureReady) return;
    void act(async () => {
      screenshot = null;
      let bytes: Uint8Array<ArrayBuffer>;
      if (saves) bytes = await saves.screenshot();
      else {
        if (!runtime.captureScreenshot) throw Error('Screenshot capture unavailable');
        await runtime.focus?.();
        bytes = await runtime.captureScreenshot();
      }
      pngInfo(bytes);
      screenshot = new Uint8Array(bytes);
    });
  }
</script>

<section class="save-controls" aria-label="Save synchronization">
  <h2>Captures and saves</h2>
  <div class="player-controls">
    {#if showQuickActions}<button type="button" disabled={blocked || !captureReady} onclick={capture}>Capture screenshot</button>{/if}
    {#if screenshot}
      <button type="button" onclick={() => downloadBytes(screenshot!, 'ecs-screenshot.png', 'image/png')}>Download screenshot</button>
      {#if saves}<button type="button" disabled={blocked} onclick={() => act(() => saves.saveScreenshot(screenshot!))}>Save screenshot to library</button>{/if}
    {/if}
  </div>
  {#if !captureReady}<p class="dim">Screenshot capture needs a supported core drawing new frames.</p>{/if}
  {#if saves}
    <p class="dim">Upload in-game progress or keep a separate state snapshot.</p>
    <div class="player-controls">
      {#if showQuickActions}<button type="button" disabled={blocked} onclick={() => save('save_state')}>Save state</button>{/if}
      <button type="button" disabled={blocked} onclick={() => save('battery_save')}>Save battery</button>
      <button type="button" disabled={blocked || !hasState} onclick={() => act(() => saves.loadSelectedState())}>Load selected state</button>
    </div>
    <p class="dim">Saves belong to {coreName} and this profile’s build.</p>
    {#if conflict}<p role="status">Kept both saves. Browser copy: <code>{conflict}</code>. The gameplay baseline stays unchanged; review copies in the library.</p>{/if}
  {:else if !supportsSaves}<p class="dim">This emulator profile does not provide save synchronization.</p>
  {:else}<p class="dim">Select a save target before starting to upload saves. Screenshot downloads are still available.</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if failure}<p role="alert" class="problem">{failure}</p>{/if}
</section>
