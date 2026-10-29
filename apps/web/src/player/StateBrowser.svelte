<script lang="ts">
  import type { ContentClient, ManifestFile } from '@ecs/client';
  import { onDestroy, untrack } from 'svelte';
  import { explain } from '../lib/problems';
  import { downloadBytes } from './downloads.js';
  import { pngDataUrl, PREVIEW_LIMIT } from './images.js';
  import { SAVE_LIMIT } from './preflight.js';
  import type { BrowserCore } from './runtime.js';
  import type { SaveSynchronizer } from './saves.js';
  import { stateCompatibility, statePreview, stateTimestamp } from './states.js';

  let {client,itemId,core,saves=null,active=false,disabled=false,refresh=0,onselect=()=>{},onbusy=()=>{}}: {
    client:Pick<ContentClient,'manifest'|'collect'>;itemId:string;core:BrowserCore;saves?:SaveSynchronizer|null;active?:boolean;disabled?:boolean;refresh?:number;
    onselect?:(id:string,known:boolean)=>void;onbusy?:(busy:boolean)=>void;
  }=$props();
  let files=$state<ManifestFile[]>([]);
  let previews=$state<Record<string,string>>({});
  let loading=$state(false),busy=$state(false),confirmed=$state(false),limit=$state(8);
  let failure=$state<string|null>(null),message=$state('');
  let generation=0;
  const states=$derived(files.filter(f=>f.kind==='save_state').sort((a,b)=>(stateTimestamp(b.relativePath)??0)-(stateTimestamp(a.relativePath)??0)));
  $effect(()=>{const id=itemId;refresh;core.id;confirmed=false;limit=8;void reload(id);});
  $effect(()=>{const visible=states.slice(0,limit);const current=files;const run=generation;untrack(()=>void loadPreviews(visible,current,run));});
  onDestroy(()=>{generation++;previews={};});
  async function reload(id:string){
    const run=++generation;loading=true;failure=null;previews={};files=[];
    try{const manifest=await client.manifest(id);if(run!==generation)return;if(manifest.itemId!==id)throw Error('Invalid state manifest');files=manifest.files;}
    catch(error){if(run===generation)failure=explain(error);}
    finally{if(run===generation)loading=false;}
  }
  async function loadPreviews(visible:ManifestFile[],all:ManifestFile[],run:number){
    // Sequential decoding bounds memory and fetch concurrency on phones.
    for(const file of visible){
      const preview=statePreview(all,file.relativePath);
      if(!preview||previews[file.id]||run!==generation)continue;
      try{const bytes=(await client.collect(preview.id,{maxBytes:PREVIEW_LIMIT})).bytes;const url=pngDataUrl(bytes);if(run===generation)previews={...previews,[file.id]:url};}catch{ /* A state remains usable without its optional preview. */ }
    }
  }
  async function act(operation:()=>Promise<void>){
    if(busy||disabled)return;busy=true;onbusy(true);failure=null;message='';
    try{await operation();}catch(error){failure=explain(error);}finally{busy=false;onbusy(false);}
  }
  function select(file:ManifestFile){
    const compatibility=stateCompatibility(file.relativePath,core);
    if(compatibility==='incompatible'||(compatibility==='unknown'&&!confirmed))return;
    if(!active){onselect(file.id,compatibility==='compatible'||confirmed);message='State selected for startup.';return;}
    void act(async()=>{if(!saves)throw Error('This session cannot load states');await saves.loadAsset(file.id,confirmed);message='State loaded.';});
  }
  function download(file:ManifestFile){void act(async()=>{const bytes=(await client.collect(file.id,{maxBytes:SAVE_LIMIT})).bytes;downloadBytes(bytes,file.relativePath);});}
</script>
<section class="state-browser" aria-label="Save state browser">
  <div class="row"><h2>Save states</h2><button type="button" disabled={loading||busy||disabled} onclick={()=>reload(itemId)}>Refresh states</button></div>
  {#if states.some(file=>stateCompatibility(file.relativePath,core)==='unknown')}<label class="state-confirm"><input type="checkbox" bind:checked={confirmed} disabled={busy||disabled} /> I verified imported states are compatible with this emulator build.</label>{/if}
  {#if loading}<p role="status">Loading save states…</p>{/if}
  {#if !loading && !states.length}<p class="dim">No save states yet. Save a state while playing to keep a snapshot here.</p>{/if}
  <div class="state-grid">
    {#each states.slice(0,limit) as file (file.id)}
      {@const compatibility=stateCompatibility(file.relativePath,core)}
      {@const timestamp=stateTimestamp(file.relativePath)}
      <article class="state-card">
        {#if previews[file.id]}<img src={previews[file.id]} alt="Preview of saved game" loading="lazy" />{:else}<div class="state-placeholder">No preview</div>{/if}
        {#if timestamp}<p><time datetime={new Date(timestamp).toISOString()}>{new Date(timestamp).toLocaleString()}</time></p>{:else}<p class="state-name">{file.relativePath}</p>{/if}
        <p class="dim">{compatibility==='compatible'?'Current emulator build':compatibility==='incompatible'?'Different or unsupported build':'Imported state · compatibility unverified'}{file.conflictOf?' · Conflict copy':''}</p>
        <div class="player-controls">
          <button type="button" disabled={busy||disabled||compatibility==='incompatible'||(compatibility==='unknown'&&!confirmed)||(active&&!saves)||file.size<=0||file.size>SAVE_LIMIT} onclick={()=>select(file)}>{active?'Load state':'Select state'}</button>
          <button type="button" disabled={busy||disabled||file.size<=0||file.size>SAVE_LIMIT} onclick={()=>download(file)}>Download state</button>
        </div>
      </article>
    {/each}
  </div>
  {#if states.length>limit}<button type="button" onclick={()=>limit+=8}>Show more states</button>{/if}
  {#if failure}<p role="alert" class="problem">{failure}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
</section>
