<script lang="ts">
  import { browserFeatures, runtimeNeeds } from '../lib/browser-features';
  import { ContentClient, type Item, type ManifestFile, type SourceFile } from '@ecs/client';
  import { onMount, tick } from 'svelte';
  import { ContentError } from '@ecs/client';
  import Login from '../Login.svelte';
  import { explain, isUnauthorized } from '../lib/problems';
  import { clearSession, loadSession, saveSession } from '../lib/session';
  import { startPlayer, type PlayerSelection } from './controller.js';
  import { allItems } from './preflight.js';
  import { supportsContentName } from './archive.js';
  import { type BrowserCore, importBrowserRuntime, usesDreamcastVmu, validateProfile } from './runtime.js';
  import SaveControls from './SaveControls.svelte';
  import SaveRecovery from './SaveRecovery.svelte';
  import Icon from '../components/Icon.svelte';
  import { systemLabel } from '../lib/content-format';
  import type { SaveKind } from './saves.js';
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
  import { playerReturnHref } from './links.js';
  import { addLine, emptyLog, logText } from './session-log.js';

  const client = new ContentClient(window.location.origin, loadSession()?.token);
  const query = new URLSearchParams(window.location.search);
  const returnHref = playerReturnHref(query.get('returnTo'), window.location.origin);
  const sourceId = query.get('source');
  const assetId = query.get('asset');
  let targetId = $state(query.get('item') ?? '');
  let gameName = $state('Browser player');
  let systemName = $state('');
  type PlayerTool = 'saves' | 'controls' | 'video' | 'options' | 'details';
  const toolTabs = [
    { id: 'saves', label: 'Saves' },
    { id: 'controls', label: 'Controls' },
    { id: 'video', label: 'Video' },
    { id: 'options', label: 'Core options' },
    { id: 'details', label: 'Details' },
  ] as const;
  let selectedTool = $state<PlayerTool>('saves');
  // The game has the window to itself; a tool is opened when it is wanted and put away after.
  let toolsOpen = $state(false);
  // Set the moment a tool is asked for, before it has opened, so a game that has just started
  // does not take the keyboard and pointer back from the person reaching for the tool.
  let toolsWanted = false;
  async function toggleTool(tool: PlayerTool, keyboard = false) {
    if (toolsOpen && selectedTool === tool) return closeTools();
    toolsWanted = true;
    await chooseTool(tool);
    if (selectedTool !== tool) return;
    toolsOpen = true;
    // Someone using the keyboard is taken into the tool. Someone using a pointer is already on
    // their way to it, and moving focus under them can swallow the click they are making.
    if (!keyboard) return;
    await tick();
    document.getElementById('player-tools-panel')?.focus({ preventScroll: true });
  }
  function closeTools() {
    if (inputSession?.draft) {
      toolNotice = 'Apply or cancel your layout edits before closing the tools.';
      return;
    }
    toolsOpen = false;
    toolsWanted = false;
    toolNotice = '';
    session?.runtime.focus?.();
  }
  let toolNotice = $state('');
  let saveControls = $state<{ save: (kind: SaveKind) => void; capture: () => void }>();
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
  /** What the start-up is doing right now, in the person's words. */
  let loadingStep = $state('Getting the game…');
  // Kept here so the lists stay open when the page redraws them as the game starts.
  let sessionDetailsOpen = $state(false), browserDetailsOpen = $state(false);
  const features = browserFeatures();
  /** What the chosen emulator cannot run without and this browser lacks. */
  const lacking = $derived(features.missing(runtimeNeeds(core?.runtime)));
  // The screen stays on while a game runs, where the browser can promise that.
  let wakeLock: { release(): Promise<void> } | null = null;
  async function keepAwake() {
    if (!session || document.hidden || !features.has('screen.wakeLock')) return;
    try {
      wakeLock = await (navigator as unknown as { wakeLock: { request(kind: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock.request('screen');
    } catch { /* Refused on low battery or by the system; the game is unaffected. */ }
  }
  // A game is watched on a dark surround whatever the library's theme is.
  $effect(() => {
    if (!session) return;
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.dataset.theme = 'dark';
    return () => {
      if (before === undefined) delete root.dataset.theme;
      else root.dataset.theme = before;
    };
  });
  $effect(() => {
    if (!session) return;
    void keepAwake();
    document.addEventListener('visibilitychange', keepAwake);
    return () => {
      document.removeEventListener('visibilitychange', keepAwake);
      void wakeLock?.release().catch(() => undefined);
      wakeLock = null;
    };
  });
  let session = $state.raw<Awaited<ReturnType<typeof startPlayer>> | null>(null);
  let preferenceStore=$state.raw<PreferenceStore|null>(null);
  let preferences=$state.raw<PlayerPreferences>({options:{},shader:'off'});
  let logs = $state(emptyLog());
  let logCopied = $state(false);
  const messages = $derived(logText(logs));
  async function copyMessages() {
    try { await navigator.clipboard.writeText(`${core?.name ?? ''}\n${messages}`); logCopied = true; } catch { logCopied = false; }
  }
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
  async function chooseTool(tool: PlayerTool) {
    if (inputSession?.draft && tool !== 'controls') {
      toolNotice = 'Apply or cancel your layout edits before changing tools.';
      toolsOpen = true;
      document.getElementById('player-tool-controls')?.focus();
      return;
    }
    try {
      inputSession?.releaseAll();
      await inputSession?.cancelCapture();
      if (disposed) return;
      selectedTool = tool;
      toolNotice = '';
    } catch (error) { failure = explain(error); }
  }
  function quickSave() {
    if (gameViewBlocked) return;
    selectedTool = 'saves';
    // What was saved, and anything that went wrong, is shown in the Saves tool.
    toolsOpen = true;
    saveControls?.save('save_state');
  }
  function quickCapture() {
    if (gameViewBlocked || !captureReady) return;
    selectedTool = 'saves';
    toolsOpen = true;
    saveControls?.capture();
  }
  async function fullscreen() {
    try { await stage?.requestFullscreen(); }
    catch (error) { failure = explain(error); }
  }
  function refreshWindow(){windowLaunch.checkClosed();launched=windowLaunch.opened;}
  function openGameWindow(){
    if(working||attempted||launched||!ready||!core||((batteryId||stateId)&&!compatible))return;
    try{
      const url=gameWindowUrl(window.location.origin,{...(sourceId?{source:sourceId}:{}),...(targetId?{item:targetId}:{}),...(assetId?{asset:assetId}:{}),profile:profileId,...(batteryId?{battery:batteryId}:{}),...(stateId?{state:stateId}:{})});
      const destination = new URL(url);
      destination.searchParams.set('returnTo', returnHref);
      windowLaunch.open(destination.href,url=>window.open(url,'_blank','popup=yes,width=1100,height=800,resizable=yes,scrollbars=yes'));
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
  function discardAndLeave(){skipUnload=true;window.location.assign(returnHref);}


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
      let system:string|null=null,name='',title='',size=0;
      if (sourceId) {
        source = (await client.sources()).items.find(file=>file.id===sourceId) ?? null;
        if (!source || source.availability!=='local' || source.groupError || ((source.groupFileCount??1)>1&&!/\.(cue|gdi)$/i.test(source.name)) || !source.systemId) throw new Error('Source is unavailable or needs a supported disc group.');
        system=source.systemId;name=source.name;title=source.name;size=source.size;
        targets=items.filter(item=>item.libraryId===source?.libraryId && item.systemIdentifier===system);
        if(targetId&&!targets.some(item=>item.id===targetId))throw new Error('The selected save target must belong to the source library and system.');
      } else {
        const item=items.find(item=>item.id===targetId);
        if(!item)throw new Error('The selected item is unavailable.');
        const file=(await client.manifest(item.id)).files.find(file=>file.id===assetId && file.kind==='rom');
        if(!file)throw new Error('The selected game file is unavailable.');
        system=item.systemIdentifier;name=file.relativePath;title=item.title;size=file.size;targets=[item];
      }
      if(/\.(ccd|m3u)$/i.test(name))throw new Error('This disc layout needs a compatible media profile.');
      const compatibleProfiles=available.filter(profile=>{try{validateProfile(profile);return profile.systems.includes(system??'') && size>0 && size<=profile.maxContentBytes && supportsContentName(profile,name);}catch{return false;}});
      if(!compatibleProfiles.length)throw new Error('No installed emulator supports this game file. Download it to use another emulator.');
      if(profileId&&!compatibleProfiles.some(profile=>profile.id===profileId))throw new Error('The selected emulator profile does not support this game.');
      if(disposed||run!==generation)return;
      gameName=title;systemName=systemLabel(system,[]);
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
    attempted = true; working = true; failure = null; loadingStep = 'Getting the game…';
    const selection: PlayerSelection = sourceId ? { kind: 'source', sourceId, ...(targetId ? { itemId: targetId } : {}) } : { kind: 'asset', itemId: targetId, assetId: assetId! };
    try {
      if(core){preferenceStore=createPreferenceStore(window.location.origin,core,sourceId?`source:${sourceId}`:targetId?`item:${targetId}`:undefined);preferences=preferenceStore.load().preferences;}
      session = await startPlayer(client, selection, {
        preferences,
        canvas, importer: importBrowserRuntime, ...('profileVersion' in (core??{}) ? {profileId}:{}), expectedProfile:core??undefined, signal:lifetime.signal, batteryAssetId: batteryId || undefined, stateAssetId: stateId || undefined, compatibleSaves: compatible,
        log(text) { logs = addLine(logs, text); logCopied = false; },
        progress(step) { loadingStep = step; },
      });
      if(disposed){session?.releaseLoader();return;}
      inputSession=new InputSession(session.runtime,createInputPreferences(window.location.origin,session.prepared.core,sourceId?`source:${sourceId}`:targetId?`item:${targetId}`:undefined));
      unsubscribeInput=inputSession.subscribe(()=>inputRevision++);
      const input=inputSession;const prepared=session.prepared;
      void input.initialize().then(async()=>{if(disposed)return;skinSession=new SkinSession(input,new SkinLibrary(),`ecs.skins.v1:${encodeURIComponent(window.location.origin)}:${prepared.core.id}:${prepared.core.loader.sha256}:${prepared.core.wasm.sha256}`,sourceId?`source:${sourceId}`:targetId?`item:${targetId}`:undefined,prepared.item?.systemIdentifier??prepared.core.systems[0]??'');unsubscribeSkins=skinSession.subscribe(()=>skinRevision++);await skinSession.initialize();});
      if(!toolsWanted&&!toolsOpen){if(session.runtime.focus)await session.runtime.focus();else canvas.focus();}
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
{#snippet sessionDetails()}
    {#if core}<details class="player-technical-details" bind:open={sessionDetailsOpen}><summary>{messages ? 'Session details and emulator messages' : 'Session details'}</summary>
      <p class="dim">{core.name} · {'profileVersion' in core ? core.buildVersion : `frontend ${core.frontendCommit.slice(0, 8)} · core ${core.coreCommit.slice(0, 8)}`}</p>
      <p class="dim">Save progress before leaving. Pending uploads can be retried or exported while this page is open. Failed startup or a command timeout requires a reload.</p>
      {#if messages}<pre class="player-log">{messages}</pre>
      <p><button type="button" onclick={() => void copyMessages()}>Copy messages</button> <span class="dim" role="status">{logCopied ? 'Copied.' : ''}</span></p>{/if}
    </details>{/if}
    <details class="player-technical-details player-browser-features" bind:open={browserDetailsOpen}><summary>This browser</summary>
      <p class="dim">What this browser offers. The player uses what is there and says so when an emulator needs something that is missing.</p>
      {#each ['Emulation', 'Graphics', 'Storage', 'Controllers', 'Sound', 'Screen', 'Layout'] as group (group)}
        <h3>{group}</h3>
        <ul>{#each features.list().filter(feature => feature.group === group) as feature (feature.id)}
          <li class:missing={!feature.available}><Icon name={feature.available ? 'check' : 'close'} /><span>{feature.label}{#if feature.use}<small class="dim"> · {feature.use}</small>{/if}</span><span class="visually-hidden">{feature.available ? 'available' : 'not available'}</span></li>
        {/each}</ul>
      {/each}
    </details>
{/snippet}
<svelte:head><title>{gameName} · Emulation Server</title></svelte:head>
<a class="player-skip-link" href={gameView ? '#game-view-controls' : session ? '#player-toolbar' : '#player-content'}>Skip to player controls</a>
<main id="player-content" tabindex="-1" class="browser-player" class:game-view={gameView} class:playing={!!session}>
  <div class="player-chrome" hidden={gameView}>
    <header class="player-session-header">
      <div class="player-session-identity">
        <a class="player-library-link" href={returnHref} onclick={stop}>{session ? 'Stop and return to library' : 'Back to library'}</a>
        <h1>{gameName}</h1>
        {#if core}<p class="dim">{systemName} · {core.name}</p>{/if}
      </div>
      {#if session}
        <div class="player-session-actions" role="group" aria-label="Session controls">
          {#if session.saves}<button class="primary" type="button" disabled={!!gameViewBlocked} onclick={quickSave}>Save state</button>{/if}
          <button type="button" disabled={!!gameViewBlocked || !captureReady} onclick={quickCapture}>Capture screenshot</button>
          <button type="button" data-game-view disabled={!!gameViewBlocked} aria-describedby={gameViewBlocked ? 'game-view-reason' : undefined} onclick={() => setGameView(true, true)}>Game view</button>
          {#if stage?.requestFullscreen}<button type="button" onclick={fullscreen}>Fullscreen</button>{/if}
        </div>
      <div class="player-toolbar" id="player-toolbar" role="toolbar" aria-label="Player tools" tabindex="-1">
        {#each toolTabs as tool (tool.id)}
          <button type="button" id={`player-tool-${tool.id}`} aria-controls="player-tools-panel"
            aria-expanded={toolsOpen && selectedTool === tool.id} disabled={working} onclick={(event) => void toggleTool(tool.id, event.detail === 0)}>{tool.label}</button>
        {/each}
      </div>
      {/if}
    </header>
    {#if needsSignIn}<Login {client} origin={window.location.origin} onsignin={(signedIn) => {
      client.setToken(signedIn.token); saveSession(signedIn); needsSignIn = false; failure = null; void boot();
    }} />{/if}
    {#if ready && !attempted}
      <section class="player-selectors" aria-label="Session setup">
        <div class="player-setup-heading"><div><h2>Session setup</h2><p class="dim">Choose your emulator and start playing.</p></div></div>
        <div class="player-setup-fields">
          <label>Emulator<select bind:value={profileId} onchange={chooseProfile} disabled={working}>{#each profiles as profile (profile.id)}<option value={profile.id}>{profile.name}</option>{/each}</select></label>
          {#if sourceId}
            <label>Save target<select bind:value={targetId} onchange={changeTarget} disabled={working}>
              <option value="">Play without saves</option>
              {#each targets as item (item.id)}<option value={item.id}>{item.title} · {item.id}</option>{/each}
            </select></label>
          {/if}
        </div>
        {#if sourceId}<p class="dim">Choose a save target to associate progress with a library game.</p>{/if}
        {#if core?.runtime === 'dolphin-wasm-esm'}<p class="dim">GameCube / Wii · {core.maxContentBytes / 1024 ** 3} GiB file limit · GameCube controller</p>{/if}
        {#if core?.saveCompletion === 'none'}<p class="dim">This profile supports playback without synchronized saves.</p>{/if}
        {#if targetId && core?.saveCompletion !== 'none' && files.some(file => file.kind === 'battery_save' || file.kind === 'save_state')}
          <details class="player-starting-saves" open={!!(batteryId || stateId)}>
            <summary>Starting saves <span class="dim">{batteryId || stateId ? 'Saved progress selected' : 'Start fresh'}</span></summary>
            <div class="player-setup-fields">
              <label>{usesDreamcastVmu(core??undefined) ? 'Compatible VMU image' : 'Compatible battery save'}<select bind:value={batteryId} disabled={working}>
                <option value="">{usesDreamcastVmu(core??undefined) ? 'Start with an empty VMU' : 'Start without a battery save'}</option>
                {#each files.filter(file => file.kind === 'battery_save') as file (file.id)}<option value={file.id}>{file.relativePath}{file.conflictOf ? ' (conflict copy)' : ' (live)'}</option>{/each}
              </select></label>
              <label>Compatible slot-0 state<select bind:value={stateId} disabled={working}>
                <option value="">Start without a state</option>
                {#each files.filter(file => file.kind === 'save_state') as file (file.id)}<option value={file.id} disabled={!!core && stateCompatibility(file.relativePath, core) === 'incompatible'}>{file.relativePath}{file.conflictOf ? ' (conflict copy)' : ''}</option>{/each}
              </select></label>
            </div>
            <label class="player-save-confirmation"><input type="checkbox" bind:checked={compatible} /> I verified these selected saves use this core’s byte format. States require this exact frontend/core pair; .sav SRAM must be known compatible.</label>
          </details>
        {/if}
        <div class="player-controls player-launch-actions">
          <button class="primary" type="button" onclick={start} disabled={working || launched || (!!(batteryId || stateId) && !compatible)}>Start</button>
          <button type="button" disabled={working || launched || !!((batteryId || stateId) && !compatible)} onclick={openGameWindow}>Open game window</button>
        </div>
        {#if lacking.length}<p class="problem" role="alert">This browser cannot run {core?.name ?? 'this emulator'}: it is missing {lacking.map(feature => feature.label.toLowerCase()).join(', ')}. {lacking[0]?.use}</p>{/if}
        {#if launched}<p role="status">Game setup opened in another window or tab. Close it to use this setup again, or <a href={returnHref}>return to library</a>.</p>{/if}
        {#if launchError}<p class="problem" role="alert">{launchError}</p>{/if}
      </section>
    {/if}
    {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
    {#if attempted && !session && !working}<p><a href={window.location.href}>Reload player</a></p>{/if}
  </div>

  <div class="player-workbench" class:running={!!session} class:starting={attempted} class:tools-open={toolsOpen}>
    <div class="player-stage-column">
      <div class="player-stage" bind:this={stage}>
        <div class="player-game" bind:this={gameMount}><canvas class="player-canvas" bind:this={canvas} tabindex="0" aria-label="Game display; focus for keyboard input"></canvas></div>
        {#if working}<div class="player-loading" role="status">
          <span class="player-loading-mark" aria-hidden="true"></span>
          <strong>{loadingStep}</strong>
          <span class="dim">{gameName}</span>
        </div>{/if}
        {#if inputSession && stage && gameMount}<TouchSurface session={inputSession} {stage} {gameMount} assets={skinAssets} />{/if}
        {#if session}<div class="game-view-toolbar player-controls" id="game-view-controls" tabindex="-1" hidden={!gameView} aria-label="Game view controls">
          <button type="button" onclick={() => setGameView(false, true)}>Show controls</button>
          <button type="button" onclick={showAirPlay}>AirPlay / Screen Mirroring</button>
          {#if inputSession}<button type="button" aria-label="Release all game controls" onclick={() => inputSession?.releaseAll()}>Release controls</button>{/if}
        </div>{/if}
      </div>
      {#if session}<div class="player-stage-footer" hidden={gameView}>
        <button class="text-button" type="button" onclick={() => session?.runtime.focus?.()}>Back to game</button>
        {#if inputSession}<button class="text-button" type="button" aria-label="Release all game controls" onclick={() => inputSession?.releaseAll()}>Release controls</button>{/if}
        <button class="text-button" type="button" onclick={showAirPlay}>AirPlay / Screen Mirroring</button>
      </div>{/if}
      {#if session && gameViewBlocked}<p class="player-game-view-reason dim" id="game-view-reason" hidden={gameView}>{gameViewBlocked}</p>{/if}
      {#if session && stage}
        <!-- Unsaved progress is never tucked away with the tools. -->
        <div hidden={gameView}>
          {#if session.saves}<SaveRecovery saves={session.saves} {refresh} disabled={playerBusy} onbusy={operationBusy} onchange={refreshSaves} />{/if}
          {#if toolNotice}<p class="player-tool-notice" role="status">{toolNotice}</p>{/if}
        </div>
      {/if}
    </div>

    {#if session && stage}
      <!-- Kept mounted while closed: saves in flight and option choices live in these components. -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape puts the panel away from anywhere inside it) -->
      <aside class="player-inspector" hidden={gameView || !toolsOpen} aria-label="Player workspace"
        onkeydown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeTools(); } }}>
        <div class="player-inspector-head">
          <h2 id="player-tools-title">{toolTabs.find(tool => tool.id === selectedTool)?.label}</h2>
          <button type="button" class="icon-only" aria-label="Hide tools" title="Hide" onclick={closeTools}><Icon name="close" /></button>
        </div>
        <div class="player-tool-panel" id="player-tools-panel" role="group" tabindex="-1" aria-labelledby="player-tools-title">
          <div hidden={selectedTool !== 'details'}>{@render sessionDetails()}</div>
          <div hidden={selectedTool !== 'saves'}>
            <SaveControls bind:this={saveControls} saves={session.saves} runtime={session.runtime} hasState={!!session.prepared.state} coreName={session.prepared.core.name}
              supportsSaves={session.prepared.core.saveCompletion !== 'none'} dreamcastVmu={usesDreamcastVmu(session.prepared.core)} {captureReady} {refresh} showQuickActions={false} disabled={playerBusy} onchange={refreshSaves} onbusy={operationBusy} />
            {#if targetId && core && core.saveCompletion !== 'none'}<StateBrowser {client} itemId={targetId} {core} {refresh} active saves={session.saves} disabled={working || playerBusy || pendingSave} onbusy={operationBusy} />{/if}
          </div>
          <div hidden={selectedTool !== 'controls'}>
            {#if inputSession}<InputControls session={inputSession} disabled={playerBusy || pendingSave} />{/if}
            {#if skinSession}<SkinControls session={skinSession} disabled={playerBusy || pendingSave} />{/if}
          </div>
          <div hidden={selectedTool !== 'video'}>
            <DisplayControls runtime={session.runtime} {stage} presentationControls={false} oninfo={info => captureReady = info.captureReady} />
          </div>
          <div hidden={selectedTool !== 'options' && selectedTool !== 'video'}>
            {#if preferenceStore}<SettingsControls runtime={session.runtime} commands={session.commands} store={preferenceStore} initial={preferences}
              view={selectedTool === 'video' ? 'video' : 'options'} active={toolsOpen && selectedTool === 'options' && !gameView}
              disabled={playerBusy || pendingSave} onbusy={operationBusy} onready={() => settingsReady = true} />{/if}
          </div>
        </div>
      </aside>
    {/if}
  </div>
  <div class="player-chrome player-session-details" hidden={gameView}>
    {#if ready && !session && targetId && core && core.saveCompletion !== 'none'}
      <StateBrowser {client} itemId={targetId} {core} {refresh} disabled={working || playerBusy || pendingSave} onbusy={operationBusy} onselect={(id, known) => { stateId = id; if (known && !batteryId) compatible = true; }} />
    {/if}
    {#if !session}{@render sessionDetails()}{/if}
  </div>
  <AirPlayHelp open={airplayOpen} canUseGameView={!!session && !working && !playerBusy && !pendingSave && !inputSession?.draft && !skinSession?.presentationOpen} onclose={closeAirPlay} />
  <dialog bind:this={leaveDialog} class="player-guidance" aria-label="Leave this game?" oncancel={event => { event.preventDefault(); keepPlaying(); }}>
    <h2>Leave this game?</h2><p>An operation or upload is unfinished. Keep playing to retry or export captured bytes. Leaving discards this session's pending bytes; no background save is performed.</p>
    <div class="player-controls"><button type="button" onclick={keepPlaying}>Keep playing</button><button type="button" onclick={discardAndLeave}>Discard and return to library</button></div>
  </dialog>
</main>
