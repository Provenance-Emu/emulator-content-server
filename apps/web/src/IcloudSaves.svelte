<script lang="ts">
  import type { ContentClient, IcloudStatus } from '@ecs/client';
  import { onDestroy, onMount } from 'svelte';
  import InlineNotice from './components/InlineNotice.svelte';
  import { bytes } from './lib/format';
  import {
    importSummary,
    macReads,
    previewSummary,
    readerNote,
    signInFailure,
    signInToken,
  } from './lib/icloud';
  import { explain, isForbidden, isUnauthorized } from './lib/problems';

  let {
    client,
    onchanged = () => {},
    onrejected = () => {},
  }: {
    client: ContentClient;
    onchanged?: () => void;
    onrejected?: (status: 401 | 403) => void;
  } = $props();

  let status = $state<IcloudStatus | null>(null);
  let failure = $state<string | null>(null);
  let working = $state(false);
  let waiting = $state(false);
  let popup: Window | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const importing = $derived(status?.import?.state === 'running');
  const mac = $derived(macReads(status?.reader));
  const note = $derived(readerNote(status?.reader));

  function failed(error: unknown) {
    if (isUnauthorized(error)) onrejected(401);
    else if (isForbidden(error) && !status) onrejected(403);
    failure = explain(error);
  }

  async function refresh() {
    try {
      const before = status?.import?.state;
      status = await client.icloudStatus();
      if (status.import?.state === 'running') timer = setTimeout(() => void refresh(), 1000);
      else {
        if (before === 'running') onchanged();
        // The Mac's reader comes and goes with the desktop app; keep what is shown true.
        if (status.reader?.offered) timer = setTimeout(() => void refresh(), 5000);
      }
    } catch (error) {
      failed(error);
    }
  }

  async function act(work: () => Promise<unknown>) {
    working = true;
    failure = null;
    try {
      await work();
      clearTimeout(timer);
      await refresh();
    } catch (error) {
      failed(error);
      // A sign-in that ran out shows as disconnected.
      clearTimeout(timer);
      await refresh();
    } finally {
      working = false;
    }
  }

  function received(event: MessageEvent) {
    // Only the sign-in window this page opened may answer.
    if (!waiting || !popup || event.source !== popup) return;
    const token = signInToken(event.origin, event.data);
    if (!token) {
      // Apple's window stays open showing its own message; say here what happened too.
      const reason = signInFailure(event.origin, event.data);
      if (reason) {
        waiting = false;
        failure = reason;
      }
      return;
    }
    waiting = false;
    popup?.close();
    popup = null;
    void act(() => client.icloudConnect(token));
  }

  async function connect() {
    failure = null;
    // Opened inside the click, before any waiting, so the browser allows it.
    popup = window.open('', 'ecs-icloud-sign-in', 'popup,width=520,height=720');
    if (!popup) {
      failure = 'Your browser blocked the sign-in window. Allow pop-ups for this page and try again.';
      return;
    }
    try {
      const address = await client.icloudSignIn();
      waiting = true;
      popup.location.href = address;
    } catch (error) {
      popup.close();
      popup = null;
      failed(error);
    }
  }

  onMount(() => {
    window.addEventListener('message', received);
    void refresh();
  });
  onDestroy(() => {
    window.removeEventListener('message', received);
    clearTimeout(timer);
    popup?.close();
  });
</script>

<h1>iCloud saves</h1>
<section aria-labelledby="icloud-heading" class="icloud-panel">
  <h2 id="icloud-heading">Bring saves in from iCloud</h2>
  <p class="dim">
    Saves made in Provenance on your phone, tablet or TV are kept in your iCloud. Sign in with the Apple
    account those devices use to copy them to the matching games here. Nothing in iCloud is changed,
    and a save already here is never replaced.
  </p>
  {#if failure}<InlineNotice kind="error">{failure}</InlineNotice>{/if}
  {#if !status}
    {#if !failure}<InlineNotice kind="status">Loading…</InlineNotice>{/if}
  {:else if !status.connected && !mac}
    {#if note}<p>{note}</p>{/if}
    {#if waiting}<InlineNotice kind="status">Finish signing in to Apple in the window that opened.</InlineNotice>{/if}
    <div class="icloud-actions">
      <button type="button" class="primary" disabled={working} onclick={() => void connect()}>Connect iCloud</button>
    </div>
    <p class="dim">The sign-in is kept only until the server restarts, and Apple ends it after two weeks at most.</p>
    {#if status.import && status.import.state !== 'running'}<p>{importSummary(status.import)}</p>{/if}
  {:else}
    {#if mac && note}<p>{note}</p>{/if}
    {#if status.import}
      <InlineNotice kind="status">{importSummary(status.import)}</InlineNotice>
      {#if importing && status.import.total}
        <progress max={status.import.total} value={status.import.processed} aria-label="Saves copied"></progress>
      {/if}
    {/if}
    {#if status.preview}
      <p>{previewSummary(status.preview)}</p>
      <dl class="icloud-counts">
        <div><dt>Ready to bring in</dt><dd>{status.preview.ready}</dd></div>
        <div><dt>Already here</dt><dd>{status.preview.alreadyHere}</dd></div>
        <div><dt>Size in iCloud</dt><dd>{bytes(status.preview.bytes)}</dd></div>
      </dl>
      {#if status.preview.unmatched.length}
        <details>
          <summary>Saves for games not in your library ({status.preview.games - status.preview.gamesHere})</summary>
          <p class="dim">These are not copied. Add the game to a library folder, let it be checked, and look again.</p>
          <ul class="icloud-unmatched">
            {#each status.preview.unmatched as game (game.gameId)}
              <li>
                {#if game.title}{game.title}{:else}<code>{game.gameId}</code>{/if}
                · {game.saves} {game.saves === 1 ? 'save' : 'saves'}
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    {/if}
    <div class="icloud-actions">
      {#if importing}
        <button type="button" disabled={working} onclick={() => void act(() => client.icloudCancelImport())}>Stop</button>
      {:else}
        {#if status.preview?.ready}
          <button type="button" class="primary" disabled={working} onclick={() => void act(() => client.icloudImport())}>
            Bring them in
          </button>
        {/if}
        <button type="button" class:primary={!status.preview?.ready} disabled={working}
          onclick={() => void act(() => client.icloudPreview())}>
          {status.preview ? 'Look again' : 'Look for saves'}
        </button>
      {/if}
      {#if status.connected}
        <button type="button" disabled={working} onclick={() => void act(() => client.icloudDisconnect())}>Disconnect</button>
      {/if}
    </div>
  {/if}
</section>
