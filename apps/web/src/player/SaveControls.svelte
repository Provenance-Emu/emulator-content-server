<script lang="ts">
  import { explain } from '../lib/problems';
  import { downloadBytes } from './downloads.js';
  import { pngInfo } from './images.js';
  import type { PlayerRuntime } from './runtime.js';
  import type { SaveKind, SaveSynchronizer } from './saves.js';
  let {saves,runtime,hasState,coreName='FCEUmm',supportsSaves=true,captureReady=false,disabled=false,onchange=()=>{},onbusy=()=>{}}:{saves:SaveSynchronizer|null;runtime:PlayerRuntime;hasState:boolean;coreName?:string;supportsSaves?:boolean;captureReady?:boolean;disabled?:boolean;onchange?:()=>void;onbusy?:(busy:boolean)=>void}=$props();
  let working=$state(false),pending=$state<SaveSynchronizer['pending']>(null),failure=$state<string|null>(null),message=$state(''),conflict=$state<string|null>(null),warning=$state<string|null>(null);
  let screenshot=$state.raw<Uint8Array<ArrayBuffer>|null>(null);
  const blocked=$derived(working||disabled||pending!==null);
  async function act(operation:()=>Promise<unknown>){
    if(working||disabled)return;working=true;onbusy(true);failure=null;message='';
    try{await operation();conflict=saves?.lastConflict?.relativePath??null;warning=saves?.previewWarning??null;message=warning??'Operation completed.';}
    catch(error){failure=explain(error);}
    finally{pending=saves?.pending??null;working=false;onbusy(false);onchange();}
  }
  function save(kind:SaveKind){if(saves)void act(()=>saves!.capture(kind));}
  function exportPending(){if(saves&&pending)downloadBytes(saves.exportPending(),pending.relativePath,pending.kind==='screenshot'?'image/png':'application/octet-stream');}
  function dismissImage(){if(!saves)return;saves.dismissPendingImage();pending=saves.pending;warning=saves.previewWarning;message=warning??'Pending image dismissed.';failure=null;onchange();}
  function capture(){void act(async()=>{
    screenshot=null;
    let bytes:Uint8Array<ArrayBuffer>;
    if(saves)bytes=await saves.screenshot();
    else{if(!runtime.captureScreenshot)throw Error('Screenshot capture unavailable');await runtime.focus?.();bytes=await runtime.captureScreenshot();}
    pngInfo(bytes);screenshot=new Uint8Array(bytes);
  });}
</script>
<section aria-label="Save synchronization">
  <h2>Captures and saves</h2>
  <div class="player-controls">
    <button type="button" disabled={blocked||!captureReady} onclick={capture}>Capture screenshot</button>
    {#if screenshot}
      <button type="button" onclick={()=>downloadBytes(screenshot!,'ecs-screenshot.png','image/png')}>Download screenshot</button>
      {#if saves}<button type="button" disabled={blocked} onclick={()=>act(()=>saves!.saveScreenshot(screenshot!))}>Save screenshot to library</button>{/if}
    {/if}
  </div>
  {#if !captureReady}<p class="dim">Screenshot capture needs a supported core drawing new frames.</p>{/if}
  {#if saves}
    <p class="dim">Saves belong to {coreName} and this profile’s build. Each state capture keeps a separate snapshot.</p>
    <div class="player-controls">
      <button type="button" disabled={blocked} onclick={()=>save('battery_save')}>Save battery</button>
      <button type="button" disabled={blocked} onclick={()=>save('save_state')}>Save state</button>
      <button type="button" disabled={blocked||!hasState} onclick={()=>act(()=>saves!.loadSelectedState())}>Load selected state</button>
    </div>
    {#if pending}
      <p>Unsynced {pending.preview?'state preview':pending.kind}: {pending.size} bytes. {pending.preview?'The state is already saved.':'These captured bytes stay available while this page is open.'}</p>
      <div class="player-controls">
        <button type="button" disabled={working||disabled||!pending.canRetry} onclick={()=>act(()=>saves!.retry())}>Retry upload</button>
        <button type="button" onclick={exportPending}>{pending.kind==='screenshot'?'Download pending image':'Export captured save'}</button>
        {#if pending.kind==='screenshot'}<button type="button" disabled={working||disabled} onclick={dismissImage}>{pending.preview?'Keep state without preview':'Dismiss pending screenshot'}</button>{/if}
      </div>
    {/if}
    {#if conflict}<p role="status">Kept both saves. Browser copy: <code>{conflict}</code>. The gameplay baseline stays unchanged; review copies in the library.</p>{/if}
  {:else if !supportsSaves}<p>This emulator profile does not provide save synchronization.</p>
  {:else}<p>Select a save target before starting to upload saves. Screenshot downloads are still available.</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if failure}<p role="alert" class="problem">{failure}</p>{/if}
</section>
