<script lang="ts">
  import { ContentClient, type Item, type ManifestFile, type SourceFile } from '@ecs/client';
  import { onMount, tick } from 'svelte';
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
  import AirPlayHelp from './AirPlayHelp.svelte';
  import {PresentationGate} from './presentation.js';
  import {GameWindowLaunch,gameWindowUrl,readGameWindowSelection,validateWindowSaves} from './windows.js';
  import SettingsControls from './SettingsControls.svelte';
  import SkinControls from './SkinControls.svelte';
  import {SkinSession} from './skins/session.js';
  import {SkinLibrary} from './skins/library.js';
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
  let skinSession=$state.raw<SkinSession|null>(null);
  let skinRevision=$state(0);
  const skinAssets=$derived.by(()=>{skinRevision;return skinSession?.assets??{};});
  let unsubscribeSkins:(()=>void)|undefined;
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
  const windowLaunch=new GameWindowLaunch();
  let launched=$state(false),launchError=$state<string|null>(null),gameView=$state(false),airplayOpen=$state(false),leaveOpen=$state(false);
  let leaveDialog=$state<HTMLDialogElement>();
  let inputRevision=$state(0),unsubscribeInput:(()=>void)|undefined;
  const presentations=new PresentationGate(()=>inputSession,()=>skinSession?.presentationOpen??false);
  let helpReturn:HTMLElement|null=null;
  let skipUnload=false;
  let settingsReady=$state(false),autoGameView=$state(false);
  $effect(()=>{if(autoGameView&&settingsReady&&!gameViewBlocked){autoGameView=false;void setGameView(true);}});
  const gameViewBlocked=$derived.by(()=>{
    inputRevision;skinRevision;
    if(!session)return 'Start the game before entering Game view.';
    if(!settingsReady)return 'Preparing display and core settings…';
    if(working||playerBusy||pendingSave)return 'Finish the operation or retry/export the pending upload before Game view.';
    if(inputSession?.draft)return 'Apply or cancel layout edits before Game view.';
    if(inputSession?.capture||skinSession?.presentationOpen||airplayOpen||leaveOpen||presentations.has('airplay')||presentations.has('leave'))return 'Close the open editor or dialog before Game view.';
    return null;
  });
  const needsUnloadWarning=$derived(playerBusy||pendingSave);
  $effect(()=>{
    if(!needsUnloadWarning)return;
    const warn=(event:BeforeUnloadEvent)=>{if(!skipUnload){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
  });
  function refreshWindow(){windowLaunch.checkClosed();launched=windowLaunch.opened;}
  function openGameWindow(){
    if(working||attempted||launched||!ready||!core||((batteryId||stateId)&&!compatible))return;
    try{
      const url=gameWindowUrl(window.location.origin,{...(sourceId?{source:sourceId}:{}),...(targetId?{item:targetId}:{}),...(assetId?{asset:assetId}:{}),profile:profileId,...(batteryId?{battery:batteryId}:{}),...(stateId?{state:stateId}:{})});
      windowLaunch.open(url,url=>window.open(url,'_blank','popup=yes,width=1100,height=800,resizable=yes,scrollbars=yes'));
      launched=windowLaunch.opened;launchError=windowLaunch.error;
    }catch(error){launchError=explain(error);}
  }
  async function setGameView(value:boolean,restoreFocus=false){
    if(value&&gameViewBlocked)return;
    inputSession?.releaseAll();await inputSession?.cancelCapture();
    if(disposed)return;
    if(value&&gameViewBlocked)return;
    gameView=value;await tick();
    if(restoreFocus){
      if(value)await session?.runtime.focus?.();
      else document.querySelector<HTMLButtonElement>('[data-game-view]')?.focus({preventScroll:true});
    }
  }
  function operationBusy(value:boolean){playerBusy=value;if(value)void setGameView(false);}
  function refreshSaves(){refresh++;pendingSave=!!session?.saves?.pending;if(pendingSave)void setGameView(false);}
  async function showAirPlay(){
    if(!presentations.acquire('airplay'))return;
    helpReturn=document.activeElement instanceof HTMLElement?document.activeElement:null;
    try{
      await inputSession?.cancelCapture();
      if(!disposed&&presentations.has('airplay'))airplayOpen=true;
      else presentations.release('airplay');
    }catch(error){presentations.release('airplay');failure=explain(error);void setGameView(false);}
  }
  async function closeAirPlay(useGameView=false){
    airplayOpen=false;presentations.release('airplay');
    await tick();
    if(useGameView)await setGameView(true,true);else helpReturn?.focus({preventScroll:true});
  }
  async function stop(event:MouseEvent){
    if(!session||(!playerBusy&&!pendingSave))return;
    event.preventDefault();
    if(!presentations.acquire('leave'))return;
    leaveOpen=true;
    try{await setGameView(false);await tick();if(!disposed)leaveDialog?.showModal();}
    catch(error){keepPlaying();failure=explain(error);}
  }
  function keepPlaying(){leaveDialog?.close();leaveOpen=false;presentations.release('leave');}
  function discardAndLeave(){skipUnload=true;window.location.assign('/ui/');}


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
      const windowSelection=readGameWindowSelection(query);
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
      const compatibleProfiles=available.filter(profile=>{try{validateProfile(profile);return profile.systems.includes(system??'') && size>0 && size<=profile.maxContentBytes && contentExtensions(profile).some(extension=>name.toLowerCase().endsWith(`.${extension}`));}catch{return false;}});
      if(!compatibleProfiles.length)throw new Error('No installed emulator supports this game file. Download it to use another emulator.');
      if(profileId&&!compatibleProfiles.some(profile=>profile.id===profileId))throw new Error('The selected emulator profile does not support this game.');
      if(disposed||run!==generation)return;
      profiles=compatibleProfiles;profileId=profileId || compatibleProfiles.find(profile=>profile.id===defaultId)?.id || compatibleProfiles[0]?.id || '';core=compatibleProfiles.find(profile=>profile.id===profileId)??null;
      await loadSaves();
      if(windowSelection){
        validateWindowSaves(windowSelection,files);
        if((windowSelection.battery||windowSelection.state)&&core?.saveCompletion==='none')throw Error('This emulator does not support the selected saves.');
        const copiedState=files.find(f=>f.id===windowSelection.state);
        if(copiedState&&core&&stateCompatibility(copiedState.relativePath,core)==='incompatible')throw Error('The selected state is incompatible with this emulator build.');
        batteryId=windowSelection.battery??'';stateId=windowSelection.state??'';compatible=false;
      }
      if(!disposed&&run===generation)ready=true;
    } catch(error) {
      if(disposed||run!==generation)return;
      if(isUnauthorized(error)){clearSession();client.setToken(undefined);needsSignIn=true;failure='Sign in to this server in your browser to continue playback.';}
      else failure=explain(error);
    }
  }
  async function start(): Promise<void> {
    if (attempted || working || launched || !ready) return;
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
      unsubscribeInput=inputSession.subscribe(()=>inputRevision++);
      const input=inputSession;const prepared=session.prepared;
      void input.initialize().then(async()=>{if(disposed)return;skinSession=new SkinSession(input,new SkinLibrary(),`ecs.skins.v1:${encodeURIComponent(window.location.origin)}:${prepared.core.id}:${prepared.core.loader.sha256}:${prepared.core.wasm.sha256}`,sourceId?`source:${sourceId}`:targetId?`item:${targetId}`:undefined,prepared.item?.systemIdentifier??prepared.core.systems[0]??'');unsubscribeSkins=skinSession.subscribe(()=>skinRevision++);await skinSession.initialize();});
      if(session.runtime.focus)await session.runtime.focus();else canvas.focus();
    } catch (error) { if(!disposed)failure = `${explain(error)} Reload this page before starting again.`; }
    finally { working = false; }
    if(session&&query.get('gameWindow')==='1')autoGameView=true;
  }
  onMount(() => {
    void boot();
    const windowTimer=setInterval(refreshWindow,750);document.addEventListener('visibilitychange',refreshWindow);
    const release = () => { disposed=true;clearInterval(windowTimer);document.removeEventListener('visibilitychange',refreshWindow);windowLaunch.dispose();presentations.dispose();unsubscribeInput?.();generation++;lifetime.abort();unsubscribeSkins?.();skinSession?.dispose();session?.releaseLoader(); };
    window.addEventListener('pagehide', release, { once: true });
    return () => {window.removeEventListener('pagehide',release);release();};
  });
</script>
<main class="browser-player" class:game-view={gameView}>
  <div class="player-chrome" hidden={gameView}>
  <div class="row"><h1>Browser player</h1><a href="/ui/" onclick={stop}>{session ? 'Stop and return to library' : 'Library / sign in'}</a></div>
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
      <button type="button" onclick={start} disabled={working || launched || (!!(batteryId || stateId) && !compatible)}>Start</button>
      <button type="button" disabled={working||launched||!!((batteryId||stateId)&&!compatible)} onclick={openGameWindow}>Open game window</button>
      {#if launched}<p role="status">Game setup opened in another window or tab. Close it to use this setup again, or <a href="/ui/">return to library</a>.</p>{/if}
      {#if launchError}<p role="alert">{launchError}</p>{/if}
    </section>
  {/if}
  </div>
  <div class="player-workbench" class:running={!!session}>
    <div class="player-stage" bind:this={stage}><div class="player-game" bind:this={gameMount}><canvas class="player-canvas" bind:this={canvas} tabindex="0" aria-label="Game display; focus for keyboard input"></canvas></div>{#if inputSession&&stage&&gameMount}<TouchSurface session={inputSession} {stage} {gameMount} assets={skinAssets}/><button type="button" class="player-release" hidden={gameView} aria-label="Release all game controls" onclick={()=>inputSession?.releaseAll()}>Release controls</button>{/if}
      {#if session}<div class="game-view-toolbar player-controls" hidden={!gameView} aria-label="Game view controls"><button type="button" onclick={()=>setGameView(false,true)}>Show controls</button><button type="button" onclick={showAirPlay}>AirPlay / Screen Mirroring</button>{#if inputSession}<button type="button" aria-label="Release all game controls" onclick={()=>inputSession?.releaseAll()}>Release controls</button>{/if}</div>{/if}</div>
    {#if inputSession}<aside class="player-inspector" hidden={gameView}>{#if skinSession}<SkinControls session={skinSession} disabled={playerBusy||pendingSave}/>{/if}<InputControls session={inputSession} disabled={playerBusy||pendingSave}/></aside>{/if}
  </div>
  <div class="player-chrome" hidden={gameView}>
  {#if working}<p role="status">Preparing complete content and core bytes…</p>{/if}
  {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
  {#if attempted && !session && !working}<p><a href={window.location.href}>Reload player</a></p>{/if}
  {#if session && stage}
    <DisplayControls runtime={session.runtime} {stage} {gameViewBlocked} ongameview={()=>setGameView(true,true)} onairplay={showAirPlay} oninfo={info=>captureReady=info.captureReady} />
    <SaveControls saves={session.saves} runtime={session.runtime} hasState={!!session.prepared.state} coreName={session.prepared.core.name} supportsSaves={session.prepared.core.saveCompletion!=='none'} {captureReady} disabled={playerBusy} onchange={refreshSaves} onbusy={operationBusy} />
    {#if preferenceStore}<SettingsControls onready={()=>settingsReady=true} runtime={session.runtime} commands={session.commands} store={preferenceStore} initial={preferences} disabled={playerBusy||pendingSave} onbusy={operationBusy} />{/if}
  {/if}
  {#if ready && targetId && core && core.saveCompletion!=='none'}
    <StateBrowser {client} itemId={targetId} {core} {refresh} active={!!session} saves={session?.saves??null} disabled={working||playerBusy||pendingSave} onbusy={operationBusy} onselect={(id,known)=>{stateId=id;if(known&&!batteryId)compatible=true;}} />
  {/if}
  {#if logs.length}<details><summary>Runtime messages</summary><pre class="player-log">{logs.join('\n')}</pre></details>{/if}
  <p class="dim">Stop leaves this document. Failed startup or command timeout requires reload. Pending uploads are lost when leaving; retry or export first. No background save on close.</p>
  </div>
  <AirPlayHelp open={airplayOpen} canUseGameView={!!session&&!working&&!playerBusy&&!pendingSave&&!inputSession?.draft&&!skinSession?.presentationOpen} onclose={closeAirPlay}/>
  <dialog bind:this={leaveDialog} class="player-guidance" aria-label="Leave this game?" oncancel={e=>{e.preventDefault();keepPlaying();}}>
    <h2>Leave this game?</h2><p>An operation or upload is unfinished. Keep playing to retry or export captured bytes. Leaving discards this session's pending bytes; no background save is performed.</p><div class="player-controls"><button type="button" onclick={keepPlaying}>Keep playing</button><button type="button" onclick={discardAndLeave}>Discard and return to library</button></div>
  </dialog>
</main>
