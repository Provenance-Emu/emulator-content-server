<script lang="ts">
  import { onMount } from 'svelte';
  import { explain } from '../lib/problems';
  import { CoreOptionRejected, type CommandChannel } from './commands.js';
  import type { CoreOption } from './options.js';
  import type { PlayerPreferences, PreferenceStore } from './preferences.js';
  import type { PlayerRuntime } from './runtime.js';
  import { validShaderId, type ShaderId, type ShaderResult } from './shaders.js';

  let {runtime,commands,store,initial,disabled=false,onbusy=()=>{}}:{runtime:PlayerRuntime;commands:CommandChannel|null;store:PreferenceStore;initial:PlayerPreferences;disabled?:boolean;onbusy?:(busy:boolean)=>void}=$props();
  let working=$state(false),failure=$state<string|null>(null),notice=$state(''),unavailable=$state('');
  let options=$state<CoreOption[]>([]),selected=$state<CoreOption|null>(null),draft=$state(''),search=$state(''),limit=$state(64);
  let shaders=$state(false),shader=$state<ShaderId|'unknown'>('off'),shaderStatus=$state('Shaders off.'),shaderRememberable=$state(true);
  let overrides=$state<Record<string,string>>({}),scopes=$state('Session only');
  let shaderEdit:ShaderId|undefined,shaderGeneration=0,failureHandled=false;
  const blocked=$derived(working||disabled);
  const matches=$derived(options.filter(o=>`${o.description} ${o.key}`.toLowerCase().includes(search.toLowerCase())));
  function updateScopes(){const loaded=store.load();scopes=loaded.scopes.length?`Remembered scopes: ${loaded.scopes.join(', ')}. Changes are session only until remembered.`:'Session only';if(loaded.warning)notice=loaded.warning;}
  async function act(operation:()=>Promise<void>,focus=true){
    if(working||disabled)return;working=true;onbusy(true);failure=null;
    try{if(focus)await runtime.focus?.();await operation();}
    catch(error){failure=explain(error);}
    finally{working=false;onbusy(false);}
  }
  function failedShader(result:ShaderResult,id:ShaderId|'unknown'){
    failureHandled=true;shader=result.selection??'unknown';shaderRememberable=shader==='off';shaderEdit=shader==='off'?'off':undefined;
    shaderStatus=shader==='off'?'Preset failed; shaders restored to Off.':'Shader state unknown. Reload the player before trying again.';failure=shaderStatus;
    if(validShaderId(id)&&id!=='off'){try{store.forgetShader(id);updateScopes();notice='The failed shader was removed from remembered settings.';}catch{notice='The failed shader could not be removed from local preferences. Clear preferences before the next launch.';}}
  }
  async function applyShader(id:ShaderId,rememberEdit=true){
    shaderGeneration++;failureHandled=false;
    shaderRememberable=false;shader='unknown';shaderStatus='Applying shader…';
    try{
      if(!runtime.setShader)throw Error('Shaders unavailable');
      const result=await runtime.setShader(id);shader=result.selection??'unknown';
      if(result.status==='failed'){failedShader(result,id);throw Error(shaderStatus);}
      shaderRememberable=true;
      if(rememberEdit)shaderEdit=id;
      shaderStatus=id==='off'?'Shaders off.':`${id==='scanlines'?'Scanlines':'LCD grid'} requested. The runtime accepted the preset and drew new frames; final compilation status is not exposed.`;
    }catch(error){if(shader==='unknown')shaderStatus='Shader state unknown. Reload the player before trying again.';throw error;}
  }
  function chooseShader(event:Event){const select=event.currentTarget as HTMLSelectElement;const id=select.value;select.value=shader;if(validShaderId(id))void act(()=>applyShader(id));}
  onMount(()=>{let active=true;
    void act(async()=>{
      updateScopes();const info=await runtime.settingsInfo?.();if(!active)return;
      shaders=info?.shaders===true;
      if(commands && info?.commands!==false){
        try{options=await commands.listOptions();if(!options.length)unavailable='This core reports no options.';}
        catch(error){if(error instanceof CoreOptionRejected)unavailable=error.message;else throw error;}
      }else unavailable='This build does not expose core-option commands.';
      if(!active)return;
      const ignored=Object.entries(initial.options).some(([key,value])=>!options.some(o=>o.key===key&&o.value===value));
      if(ignored)notice='Some remembered options were not accepted by this build. Review their current values.';
      if(initial.shader!=='off'){if(shaders)await applyShader(initial.shader,false);else notice='The remembered shader is unavailable in this build.';}
    });
    let checking=false;
    const timer=setInterval(async()=>{
      if(!active||working||disabled||!shaders||checking)return;checking=true;const generation=shaderGeneration;
      try{const info=await runtime.settingsInfo?.();if(active&&!working&&!disabled&&generation===shaderGeneration&&info?.shaderResult?.status==='failed'&&!failureHandled)failedShader(info.shaderResult,shader);}
      catch{ /* The active operation or session teardown reports transport failure. */ }
      finally{checking=false;}
    },1000);
    return()=>{active=false;clearInterval(timer);};
  });
  function edit(option:CoreOption){void act(async()=>{if(!commands)return;selected=await commands.option(option.key);draft=selected.value;});}
  function applyOption(){void act(async()=>{
    if(!commands||!selected)return;const key=selected.key,value=draft;
    const applied=await commands.setOption(key,value);overrides={...overrides,[key]:applied.value};
    options=await commands.listOptions();selected=await commands.option(key);draft=selected.value;
    notice='Option accepted. Some options take effect on the next launch; no restart was performed.';
  });}
  function remember(scope:'core'|'game'){void act(async()=>{
    if(!shaderRememberable||shader==='unknown')throw Error('Resolve the shader failure before remembering settings');
    const info=await runtime.settingsInfo?.();
    if(info?.shaderResult?.status==='failed'&&!failureHandled){failedShader(info.shaderResult,shader);throw Error(shaderStatus);}
    store.rememberChanges(scope,{options:{...overrides},...(shaderEdit!==undefined?{shader:shaderEdit}:{})});updateScopes();notice=`Remembered for this ${scope==='game'?'game':'core'} in this browser.`;
  },false);}
  function clear(scope:'core'|'game'){void act(async()=>{store.clear(scope);updateScopes();notice='Remembered settings cleared. Running settings remain until changed or a fresh launch.';},false);}
</script>
<section class="settings-controls" aria-label="Core options and shaders">
  <h2>Core options and shaders</h2>
  <p class="dim">Local to this browser and server, for this exact core build. {scopes}. Save your progress before leaving; some core options require a fresh launch.</p>
  <div class="player-controls">
    <label>Shader preset<select value={shader} disabled={blocked||!shaders||shader==='unknown'} onchange={chooseShader}>
      {#if shader==='unknown'}<option value="unknown">Unknown — reload player</option>{/if}
      <option value="off">Off</option><option value="scanlines">Scanlines</option><option value="lcd">LCD grid</option>
    </select></label>
  </div>
  {#if shaders}<p role="status">{shaderStatus}</p><p class="dim">Screenshots include the shader. State previews may show raw game pixels. Sharp/smooth display filtering is a separate setting. Off uses the least graphics work.</p>
  {:else}<p class="dim">This build does not expose the required GLSL shader hooks.</p>{/if}
  {#if unavailable}<p class="dim">Core options unavailable: {unavailable}</p>{/if}
  <details open><summary>Core options</summary>
  {#if options.length}
    <label>Search core options<input type="search" bind:value={search} oninput={()=>limit=64} /></label>
    <p class="dim">{matches.length} options. Defaults and categories are not reported by this runtime.</p>
    <div class="core-option-list">
      {#each matches.slice(0,limit) as option (option.key)}
        <div class="core-option-row"><span>{option.description||option.key}<small>{option.key} · {option.value}</small></span><button type="button" disabled={blocked} aria-label={`Edit ${option.description||option.key}`} onclick={()=>edit(option)}>Edit</button></div>
      {/each}
    </div>
    {#if matches.length>limit}<button type="button" onclick={()=>limit+=64}>Show more options</button>{/if}
  {/if}
  {#if selected}
    <div class="player-controls"><label>{selected.description||selected.key}<select bind:value={draft} disabled={blocked}>{#each selected.values??[] as value}<option {value}>{value}</option>{/each}</select></label><button type="button" disabled={blocked} onclick={applyOption}>Apply option</button></div>
  {/if}
  </details>
  <div class="player-controls">
    <button type="button" disabled={blocked||!shaderRememberable||(!options.length&&!shaders)} onclick={()=>remember('core')}>Remember for this core</button>
    {#if store.hasGame}<button type="button" disabled={blocked||!shaderRememberable||(!options.length&&!shaders)} onclick={()=>remember('game')}>Remember for this game</button>{/if}
    <button type="button" disabled={blocked} onclick={()=>clear('core')}>Clear core preferences</button>
    {#if store.hasGame}<button type="button" disabled={blocked} onclick={()=>clear('game')}>Clear game preferences</button>{/if}
  </div>
  <p class="dim">Clearing preferences uses the core’s defaults on a fresh launch. No automatic restart or live reset.</p>
  {#if working}<p role="status">Updating player settings…</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
</section>
