<script lang="ts">
  import { ContentClient, type Item, type ManifestFile, type PlayerCoreDescriptor, type SourceFile } from '@ecs/client';
  import { onMount } from 'svelte';
  import Login from '../Login.svelte';
  import { explain, isUnauthorized } from '../lib/problems';
  import { clearSession, loadSession, saveSession } from '../lib/session';
  import { startPlayer, type PlayerSelection } from './controller.js';
  import { allItems } from './preflight.js';
  import { importBrowserRuntime, validateProfile } from './runtime.js';
  import SaveControls from './SaveControls.svelte';

  const client = new ContentClient(window.location.origin, loadSession()?.token);
  const query = new URLSearchParams(window.location.search);
  const sourceId = query.get('source');
  const assetId = query.get('asset');
  let targetId = $state(query.get('item') ?? '');
  let core = $state<PlayerCoreDescriptor | null>(null);
  let source = $state<SourceFile | null>(null);
  let targets = $state<Item[]>([]);
  let files = $state<ManifestFile[]>([]);
  let batteryId = $state('');
  let stateId = $state('');
  let compatible = $state(false);
  let canvas: HTMLCanvasElement;
  let ready = $state(false);
  let needsSignIn = $state(false);
  let working = $state(false);
  let attempted = $state(false);
  let failure = $state<string | null>(null);
  let session = $state.raw<Awaited<ReturnType<typeof startPlayer>> | null>(null);
  let logs = $state<string[]>([]);

  async function loadSaves(): Promise<void> {
    files = []; batteryId = ''; stateId = ''; compatible = false;
    if (targetId) files = (await client.manifest(targetId)).files;
  }
  async function changeTarget(): Promise<void> {
    working = true; failure = null;
    try { await loadSaves(); } catch (error) { failure = explain(error); }
    finally { working = false; }
  }
  async function boot(): Promise<void> {
    try {
      if ((!sourceId && (!assetId || !targetId)) || (sourceId && assetId)) throw new Error('Open Play from a NES file in the library or a local source folder.');
      if (!(await client.capabilities()).features.webPlayback) throw new Error('Browser playback is unavailable. Ask the operator to configure --player-dir.');
      const descriptor = await client.playerCore();
      validateProfile(descriptor);
      core = descriptor;
      const items = await allItems(client);
      if (sourceId) {
        source = (await client.sources()).items.find((file) => file.id === sourceId) ?? null;
        if (!source || source.availability !== 'local' || !source.systemId || !descriptor.systems.includes(source.systemId)) throw new Error('Source is unavailable or has an unsupported system.');
        targets = items.filter((item) => item.libraryId === source?.libraryId && item.systemIdentifier === source?.systemId);
        if (targetId && !targets.some((item) => item.id === targetId)) throw new Error('The selected save target must belong to the source library and system.');
      } else {
        targets = items.filter((item) => item.id === targetId && descriptor.systems.includes(item.systemIdentifier));
        if (!targets.length) throw new Error('The selected NES item is unavailable.');
      }
      await loadSaves();
      ready = true;
    } catch (error) {
      if (isUnauthorized(error)) {
        clearSession(); client.setToken(undefined); needsSignIn = true;
        failure = 'Sign in to this server in your browser to continue playback.';
      } else failure = explain(error);
    }
  }
  async function start(): Promise<void> {
    if (attempted || working || !ready) return;
    attempted = true; working = true; failure = null;
    const selection: PlayerSelection = sourceId ? { kind: 'source', sourceId, ...(targetId ? { itemId: targetId } : {}) } : { kind: 'asset', itemId: targetId, assetId: assetId! };
    try {
      session = await startPlayer(client, selection, {
        canvas, importer: importBrowserRuntime, batteryAssetId: batteryId || undefined, stateAssetId: stateId || undefined, compatibleSaves: compatible,
        log(text) { logs = [...logs.slice(-7), text.slice(0, 300)]; },
      });
      canvas.focus();
    } catch (error) { failure = `${explain(error)} Reload this page before starting again.`; }
    finally { working = false; }
  }
  onMount(() => {
    void boot();
    const release = () => session?.releaseLoader();
    window.addEventListener('pagehide', release, { once: true });
    return () => window.removeEventListener('pagehide', release);
  });
</script>
<main>
  <div class="row"><h1>Browser player</h1><a href="/ui/">{session ? 'Stop and return to library' : 'Library / sign in'}</a></div>
  <p class="dim">Single-file NES · trusted FCEUmm core · keyboard focus on canvas</p>
  {#if core}
    <p>{core.name} · frontend {core.frontendCommit.slice(0, 8)} · core {core.coreCommit.slice(0, 8)}</p>
  {/if}
  {#if needsSignIn}<Login {client} onsignin={(signedIn) => {
    saveSession(signedIn); needsSignIn = false; failure = null; void boot();
  }} />{/if}
  {#if ready && !attempted}
    <section class="player-selectors">
      <h2>Session setup</h2>
      {#if sourceId}
        <p>Source: {source?.name}. Choose a save target explicitly; matching titles do not create an association.</p>
        <label>Save target
          <select bind:value={targetId} onchange={changeTarget} disabled={working}>
            <option value="">Play without saves</option>
            {#each targets as item (item.id)}<option value={item.id}>{item.title} · {item.id}</option>{/each}
          </select>
        </label>
      {/if}
      {#if targetId}
        <label>Compatible battery save
          <select bind:value={batteryId} disabled={working}>
            <option value="">Start without a battery save</option>
            {#each files.filter((file) => file.kind === 'battery_save') as file (file.id)}
              <option value={file.id}>{file.relativePath}{file.conflictOf ? ' (conflict copy)' : ' (live)'}</option>
            {/each}
          </select>
        </label>
        <label>Compatible slot-0 state
          <select bind:value={stateId} disabled={working}>
            <option value="">Start without a state</option>
            {#each files.filter((file) => file.kind === 'save_state') as file (file.id)}
              <option value={file.id}>{file.relativePath}{file.conflictOf ? ' (conflict copy)' : ''}</option>
            {/each}
          </select>
        </label>
        <label><input type="checkbox" bind:checked={compatible} /> I verified these selected saves use this core’s byte format. States require this exact frontend/core pair; .sav SRAM must be known compatible.</label>
      {/if}
      <button type="button" onclick={start} disabled={working || (!!(batteryId || stateId) && !compatible)}>Start</button>
    </section>
  {/if}
  <canvas class="player-canvas" bind:this={canvas} tabindex="0" aria-label="NES game display; focus for keyboard input"></canvas>
  {#if working}<p role="status">Preparing complete content and core bytes…</p>{/if}
  {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
  {#if attempted && !session && !working}<p><a href={window.location.href}>Reload player</a></p>{/if}
  {#if session}<SaveControls saves={session.saves} hasState={!!session.prepared.state} />{/if}
  {#if logs.length}<details><summary>Runtime messages</summary><pre class="player-log">{logs.join('\n')}</pre></details>{/if}
  <p class="dim">Stop leaves this document. Failed startup or command timeout requires reload. Pending uploads are lost when leaving; retry or export first. No background save on close.</p>
</main>
