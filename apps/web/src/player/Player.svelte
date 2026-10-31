<script lang="ts">
  import { ContentClient, type Item, type ManifestFile, type SourceFile } from '@ecs/client';
  import { onMount } from 'svelte';
  import { ContentError } from '@ecs/client';
  import Login from '../Login.svelte';
  import { explain, isUnauthorized } from '../lib/problems';
  import { clearSession, loadSession, saveSession } from '../lib/session';
  import { startPlayer, type PlayerSelection } from './controller.js';
  import { allItems } from './preflight.js';
  import { type BrowserCore, contentExtensions, importBrowserRuntime, validateProfile } from './runtime.js';
  import SaveControls from './SaveControls.svelte';
  import StateBrowser from './StateBrowser.svelte';
  import DisplayControls from './DisplayControls.svelte';
  import SettingsControls from './SettingsControls.svelte';
  import InputControls from './InputControls.svelte';
  import TouchSurface from './TouchSurface.svelte';
  import {InputSession} from './input-session.js';
  import {createInputPreferences} from './input-preferences.js';
  import { createPreferenceStore, type PreferenceStore, type PlayerPreferences } from './preferences.js';
  import { stateCompatibility } from './states.js';

  const client = new ContentClient(window.location.origin, loadSession()?.token);
  const query = new URLSearchParams(window.location.search);
  const sourceId = query.get('source');
  const assetId = query.get('asset');
  let targetId = $state(query.get('item') ?? '');
  let core = $state<BrowserCore | null>(null);
  let profiles = $state<BrowserCore[]>([]);
  let profileId = $state(query.get('profile') ?? '');
  const lifetime = new AbortController();
  let disposed=false;
  let generation=0;
  let source = $state<SourceFile | null>(null);
  let targets = $state<Item[]>([]);
  let files = $state<ManifestFile[]>([]);
  let batteryId = $state('');
  let stateId = $state('');
  let compatible = $state(false);
  let canvas: HTMLCanvasElement;
  let stage=$state<HTMLDivElement>();
  let gameMount=$state<HTMLDivElement>();
  let inputSession=$state.raw<InputSession|null>(null);
  let playerBusy=$state(false),captureReady=$state(false),refresh=$state(0),pendingSave=$state(false);
  let ready = $state(false);
  let needsSignIn = $state(false);
  let working = $state(false);
  let attempted = $state(false);
  let failure = $state<string | null>(null);
  let session = $state.raw<Awaited<ReturnType<typeof startPlayer>> | null>(null);
  let preferenceStore=$state.raw<PreferenceStore|null>(null);
  let preferences=$state.raw<PlayerPreferences>({options:{},shader:'off'});
  let logs = $state<string[]>([]);

  async function loadSaves(): Promise<void> {
    files = []; batteryId = ''; stateId = ''; compatible = false;
    if (targetId && core?.saveCompletion!=='none') files = (await client.manifest(targetId)).files;
  }
  async function changeTarget(): Promise<void> {
    working = true; failure = null;
    try { await loadSaves(); } catch (error) { failure = explain(error); }
    finally { working = false; }
  }
  function chooseProfile(): void {
    core = profiles.find(profile=>profile.id===profileId) ?? null;
    void changeTarget();
  }
  async function boot(): Promise<void> {
    const run=++generation;ready=false;
    try {
      if ((!sourceId && (!assetId || !targetId)) || (sourceId && assetId)) throw new Error('Open Play from a game file in your library.');
      if (!(await client.capabilities()).features.webPlayback) throw new Error('Browser playback is unavailable. Configure an emulator profile on the server.');
      let available:BrowserCore[]=[];let defaultId:string|null=null;
      try { const catalog=await client.playerProfiles();available=catalog.items;defaultId=catalog.defaultProfileId; }
      catch(error) { if(!(error instanceof ContentError)||error.status!==404)throw error;const legacy=await client.playerCore();available=[legacy];defaultId=legacy.id; }
      const items = await allItems(client);
      let system:string|null=null,name='',size=0;
      if (sourceId) {
        source = (await client.sources()).items.find(file=>file.id===sourceId) ?? null;
        if (!source || source.availability!=='local' || source.groupError || ((source.groupFileCount??1)>1&&!/\.cue$/i.test(source.name)) || !source.systemId) throw new Error('Source is unavailable or needs a supported disc group.');
        system=source.systemId;name=source.name;size=source.size;
        targets=items.filter(item=>item.libraryId===source?.libraryId && item.systemIdentifier===system);
        if(targetId&&!targets.some(item=>item.id===targetId))throw new Error('The selected save target must belong to the source library and system.');
      } else {
        const item=items.find(item=>item.id===targetId);
        if(!item)throw new Error('The selected item is unavailable.');
        const file=(await client.manifest(item.id)).files.find(file=>file.id===assetId && file.kind==='rom');
        if(!file)throw new Error('The selected game file is unavailable.');
        system=item.systemIdentifier;name=file.relativePath;size=file.size;targets=[item];
      }
      if(/\.(gdi|ccd|m3u)$/i.test(name))throw new Error('This disc layout needs a compatible media profile.');
      const compatible=available.filter(profile=>{try{validateProfile(profile);return profile.systems.includes(system??'') && size>0 && size<=profile.maxContentBytes && contentExtensions(profile).some(extension=>name.toLowerCase().endsWith(`.${extension}`));}catch{return false;}});
      if(!compatible.length)throw new Error('No installed emulator supports this game file. Download it to use another emulator.');
      if(profileId&&!compatible.some(profile=>profile.id===profileId))throw new Error('The selected emulator profile does not support this game.');
      if(disposed||run!==generation)return;
      profiles=compatible;profileId=profileId || compatible.find(profile=>profile.id===defaultId)?.id || compatible[0]?.id || '';core=compatible.find(profile=>profile.id===profileId)??null;
      await loadSaves();
      if(!disposed&&run===generation)ready=true;
    } catch(error) {
      if(disposed||run!==generation)return;
      if(isUnauthorized(error)){clearSession();client.setToken(undefined);needsSignIn=true;failure='Sign in to this server in your browser to continue playback.';}
      else failure=explain(error);
    }
  }
  async function start(): Promise<void> {
    if (attempted || working || !ready) return;
    attempted = true; working = true; failure = null;
    const selection: PlayerSelection = sourceId ? { kind: 'source', sourceId, ...(targetId ? { itemId: targetId } : {}) } : { kind: 'asset', itemId: targetId, assetId: assetId! };
    try {
      if(core){preferenceStore=createPreferenceStore(window.location.origin,core,sourceId?`source:${sourceId}`:targetId?`item:${targetId}`:undefined);preferences=preferenceStore.load().preferences;}
      session = await startPlayer(client, selection, {
        preferences,
        canvas, importer: importBrowserRuntime, ...('profileVersion' in (core??{}) ? {profileId}:{}), expectedProfile:core??undefined, signal:lifetime.signal, batteryAssetId: batteryId || undefined, stateAssetId: stateId || undefined, compatibleSaves: compatible,
        log(text) { logs = [...logs.slice(-7), text.slice(0, 300)]; },
      });
      if(disposed){session?.releaseLoader();return;}
      inputSession=new InputSession(session.runtime,createInputPreferences(window.location.origin,session.prepared.core,sourceId?`source:${sourceId}`:targetId?`item:${targetId}`:undefined));
      void inputSession.initialize();
      if(session.runtime.focus)await session.runtime.focus();else canvas.focus();
    } catch (error) { if(!disposed)failure = `${explain(error)} Reload this page before starting again.`; }
    finally { working = false; }
  }
  onMount(() => {
    void boot();
    const release = () => { disposed=true;generation++;lifetime.abort();session?.releaseLoader(); };
    window.addEventListener('pagehide', release, { once: true });
    return () => {window.removeEventListener('pagehide',release);release();};
  });
</script>
<main class="browser-player">
  <div class="row"><h1>Browser player</h1><a href="/ui/">{session ? 'Stop and return to library' : 'Library / sign in'}</a></div>
  <p class="dim">Installed emulator profiles · supported games and CUE/BIN discs · keyboard focus in the game display</p>
  {#if core}
    <p>{core.name} · {'profileVersion' in core ? core.buildVersion : `frontend ${core.frontendCommit.slice(0,8)} · core ${core.coreCommit.slice(0,8)}`}</p>
  {/if}
  {#if needsSignIn}<Login {client} origin={window.location.origin} onsignin={(signedIn) => {
    client.setToken(signedIn.token); saveSession(signedIn); needsSignIn = false; failure = null; void boot();
  }} />{/if}
  {#if ready && !attempted}
    <section class="player-selectors">
      <h2>Session setup</h2>
      <label>Emulator<select bind:value={profileId} onchange={chooseProfile} disabled={working}>{#each profiles as profile (profile.id)}<option value={profile.id}>{profile.name}</option>{/each}</select></label>
      {#if core?.runtime==='dolphin-wasm-esm'}<p class="dim">Local browser · GameCube · 512 MiB file limit · 1 controller</p>{/if}
      {#if core?.saveCompletion==='none'}<p class="dim">This profile supports playback without synchronized saves.</p>{/if}
      {#if sourceId}
        <p>Source: {source?.name}. Choose a save target explicitly; matching titles do not create an association.</p>
        <label>Save target
          <select bind:value={targetId} onchange={changeTarget} disabled={working}>
            <option value="">Play without saves</option>
            {#each targets as item (item.id)}<option value={item.id}>{item.title} · {item.id}</option>{/each}
          </select>
        </label>
      {/if}
      {#if targetId && core?.saveCompletion!=='none'}
        <label>Compatible battery save
          <select bind:value={batteryId} disabled={working}>
            <option value="">Start without a battery save</option>
            {#each files.filter((file) => file.kind === 'battery_save') as file (file.id)}
              <option value={file.id} disabled={file.kind==='save_state' && !!core && stateCompatibility(file.relativePath,core)==='incompatible'}>{file.relativePath}{file.conflictOf ? ' (conflict copy)' : ' (live)'}</option>
            {/each}
          </select>
        </label>
        <label>Compatible slot-0 state
          <select bind:value={stateId} disabled={working}>
            <option value="">Start without a state</option>
            {#each files.filter((file) => file.kind === 'save_state') as file (file.id)}
              <option value={file.id} disabled={file.kind==='save_state' && !!core && stateCompatibility(file.relativePath,core)==='incompatible'}>{file.relativePath}{file.conflictOf ? ' (conflict copy)' : ''}</option>
            {/each}
          </select>
        </label>
        <label><input type="checkbox" bind:checked={compatible} /> I verified these selected saves use this core’s byte format. States require this exact frontend/core pair; .sav SRAM must be known compatible.</label>
      {/if}
      <button type="button" onclick={start} disabled={working || (!!(batteryId || stateId) && !compatible)}>Start</button>
    </section>
  {/if}
  <div class="player-workbench" class:running={!!session}>
    <div class="player-stage" bind:this={stage}><div class="player-game" bind:this={gameMount}><canvas class="player-canvas" bind:this={canvas} tabindex="0" aria-label="Game display; focus for keyboard input"></canvas></div>{#if inputSession&&stage&&gameMount}<TouchSurface session={inputSession} {stage} {gameMount}/><button type="button" class="player-release" aria-label="Release all game controls" onclick={()=>inputSession?.releaseAll()}>Release controls</button>{/if}</div>
    {#if inputSession}<InputControls session={inputSession} disabled={playerBusy||pendingSave}/>{/if}
  </div>
  {#if working}<p role="status">Preparing complete content and core bytes…</p>{/if}
  {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
  {#if attempted && !session && !working}<p><a href={window.location.href}>Reload player</a></p>{/if}
  {#if session && stage}
    <DisplayControls runtime={session.runtime} {stage} oninfo={info=>captureReady=info.captureReady} />
    <SaveControls saves={session.saves} runtime={session.runtime} hasState={!!session.prepared.state} coreName={session.prepared.core.name} supportsSaves={session.prepared.core.saveCompletion!=='none'} {captureReady} disabled={playerBusy} onchange={()=>{refresh++;pendingSave=!!session?.saves?.pending;}} onbusy={busy=>playerBusy=busy} />
    {#if preferenceStore}<SettingsControls runtime={session.runtime} commands={session.commands} store={preferenceStore} initial={preferences} disabled={playerBusy||pendingSave} onbusy={busy=>playerBusy=busy} />{/if}
  {/if}
  {#if ready && targetId && core && core.saveCompletion!=='none'}
    <StateBrowser {client} itemId={targetId} {core} {refresh} active={!!session} saves={session?.saves??null} disabled={working||playerBusy||pendingSave} onbusy={busy=>playerBusy=busy} onselect={(id,known)=>{stateId=id;if(known&&!batteryId)compatible=true;}} />
  {/if}
  {#if logs.length}<details><summary>Runtime messages</summary><pre class="player-log">{logs.join('\n')}</pre></details>{/if}
  <p class="dim">Stop leaves this document. Failed startup or command timeout requires reload. Pending uploads are lost when leaving; retry or export first. No background save on close.</p>
</main>
