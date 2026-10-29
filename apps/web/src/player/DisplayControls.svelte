<script lang="ts">
  import { onMount } from 'svelte';
  import type { DisplayInfo, DisplaySettings, PlayerRuntime } from './runtime.js';
  import { explain } from '../lib/problems';
  let {runtime,stage,oninfo=()=>{}}:{runtime:PlayerRuntime;stage:HTMLElement;oninfo?:(info:DisplayInfo)=>void}=$props();
  let fit=$state<DisplaySettings['fit']>('contain'),aspect=$state<DisplaySettings['aspect']>('auto'),filter=$state<DisplaySettings['filter']>('pixelated');
  let height=$state(65),failure=$state<string|null>(null),output=$state(''),fullscreen=$state(false);
  onMount(()=>{
    let stopped=false,inFlight=false;
    fullscreen=typeof stage.requestFullscreen==='function';
    const poll=async()=>{if(stopped||inFlight||!runtime.displayInfo)return;inFlight=true;try{const info=await runtime.displayInfo();if(!stopped){output=`${info.width} × ${info.height}`;oninfo(info);}}catch{ /* Session teardown stops the poll below. */ }finally{inFlight=false;}};
    void poll();const timer=setInterval(poll,1000);return()=>{stopped=true;clearInterval(timer);};
  });
  async function apply(){try{await runtime.setDisplay?.({fit,aspect,filter});failure=null;}catch(error){failure=explain(error);}}
  function resize(){stage.style.height=`${height}svh`;}
  async function enterFullscreen(){try{await stage.requestFullscreen();}catch(error){failure=explain(error);}}
</script>
<section class="display-controls" aria-label="Display controls">
  <h2>Display</h2>
  <div class="player-controls">
    <label>Scaling<select bind:value={fit} onchange={apply}><option value="contain">Fit</option><option value="fill">Fill (stretch)</option></select></label>
    <label>Aspect ratio<select bind:value={aspect} onchange={apply}><option value="auto">Automatic</option><option value="4:3">4:3</option><option value="16:9">16:9</option><option value="1:1">Square</option></select></label>
    <label>Filtering<select bind:value={filter} onchange={apply}><option value="pixelated">Sharp pixels</option><option value="smooth">Smooth</option></select></label>
    <label>Display height<input type="range" min="30" max="85" step="5" bind:value={height} oninput={resize} /></label>
    {#if fullscreen}<button type="button" onclick={enterFullscreen}>Fullscreen</button>{/if}
  </div>
  <p class="dim">{output?`Output ${output}. `:''}Integer scaling needs native core geometry, which this runtime does not report.</p>
  {#if failure}<p role="alert" class="problem">{failure}</p>{/if}
</section>
