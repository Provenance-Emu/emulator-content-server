<script lang="ts">
  import type { ContentRoot, SourceOrganizationPreview, SourceOrganizationPolicy } from '@ecs/client';
  import { onDestroy } from 'svelte';
  import type { ServerContext } from './lib/application';
  import { explain } from './lib/problems';

  let {context,sourceId,sourceRootId,libraryId,owner,onchanged}:{context:ServerContext;sourceId:string;sourceRootId?:string;libraryId:string|null;owner:boolean;onchanged:()=>void}=$props();
  let opened=$state(false);
  let policy=$state<SourceOrganizationPolicy|null>(null);
  let policyBusy=$state(false);
  let policyFailure=$state<string|null>(null);
  let policyScope='';
  $effect(()=>{const rootId=sourceRootId;const client=context.client;let active=true;policy=null;policyFailure=null;if(owner&&rootId)void client.sourceOrganizationPolicy(rootId).then(value=>{if(active){policy=value;policyScope=rootId;}}).catch(error=>{if(active)policyFailure=explain(error);});return()=>{active=false;};});
  let roots=$state<ContentRoot[]>([]);
  let mode=$state<'copy'|'move'>('copy');
  let targetRootId=$state('');
  let plan=$state<SourceOrganizationPreview|null>(null);
  let busy=$state(false);
  let failure=$state<string|null>(null);
  let complete=$state<string|null>(null);
  let lifetime=0;
  let disposed=false;
  onDestroy(()=>{disposed=true;lifetime++;});
  function cancel(){opened=false;plan=null;failure=null;lifetime++;busy=false;}
  async function open(){
    opened=true;plan=null;failure=null;complete=null;busy=true;
    const epoch=++lifetime;
    try {
      const response=await context.client.roots();
      if(disposed||epoch!==lifetime)return;
      roots=response.items.filter((root)=>root.libraryId===libraryId);
      targetRootId=roots[0]?.id??'';
    } catch(error){if(!disposed&&epoch===lifetime)failure=explain(error);}
    finally {if(!disposed&&epoch===lifetime)busy=false;}
  }
  async function preview(){
    plan=null;failure=null;busy=true;const epoch=++lifetime;
    try {
      const response=await context.client.previewSourceOrganization(sourceId,{mode,targetRootId});
      if(!disposed&&epoch===lifetime){plan=response;if(!sourceRootId){const current=await context.client.sourceOrganizationPolicy(response.sourceRootId);if(!disposed&&epoch===lifetime){policy=current;policyScope=response.sourceRootId;}}}
    }catch(error){if(!disposed&&epoch===lifetime)failure=explain(error);}
    finally{if(!disposed&&epoch===lifetime)busy=false;}
  }
  async function apply(){
    if(!plan)return;
    const confirmed=plan;busy=true;failure=null;const epoch=++lifetime;
    try {
      const result=await context.client.applySourceOrganization(sourceId,confirmed.planId);
      if(disposed||epoch!==lifetime)return;
      plan=null;opened=false;complete=confirmed.mode==='copy'?'File copied. The original and its saved matches remain available.':'File moved. Saved matches remain attached to this game.';
      if(result.warning)complete=result.warning;
      onchanged();
    }catch(error){if(!disposed&&epoch===lifetime){plan=null;failure=explain(error);}}
    finally{if(!disposed&&epoch===lifetime)busy=false;}
  }
  async function setAutomatic(enabled:boolean){
    const rootId=plan?.sourceRootId??sourceRootId??policyScope;
    if(!rootId||enabled&&!plan)return;
    policyBusy=true;policyFailure=null;const epoch=++lifetime;
    try {
      const result=await context.client.setSourceOrganizationPolicy(rootId,{enabled,...(enabled&&plan?{planId:plan.planId}:{})});
      if(disposed||epoch!==lifetime)return;
      policy=result;policyScope=rootId;
      if(enabled){plan=null;opened=false;complete='Automatic organization enabled for future saved matches in this source folder. Existing files have not been changed.';}
      else complete='Automatic organization is off. Future saved matches will leave original files in place.';
    }catch(error){if(!disposed&&epoch===lifetime){policyFailure=explain(error);if(enabled)plan=null;}}
    finally{if(!disposed&&epoch===lifetime)policyBusy=false;}
  }
</script>

{#if owner}
<section class="organization" aria-label="Organize original file">
  <h2>Organize files</h2>
  <p class="dim">Optionally arrange one cartridge ROM into System / Matched title / Original filename. Preview a file before applying a change or enabling automatic organization for its source folder. Archives and disc sets are not supported. Automatic organization starts off.</p>
  {#if policy?.enabled}
    <p role="status">Automatic {policy.mode==='move'?'Move':'Copy'} is enabled for this source folder. Future saved metadata, artwork or system matches organize eligible cartridge ROMs into {roots.find(root=>root.id===policy?.targetRootId)?.label??'the confirmed destination folder'}. Move waits for suggested local metadata and artwork choices to be saved. Existing files are not processed in bulk.</p>
    <button type="button" disabled={policyBusy||busy} onclick={()=>void setAutomatic(false)}>{policyBusy?'Turning off…':'Turn off automatic organization'}</button>
  {:else if policy}<p class="dim">Automatic organization is off for this source folder.</p>{/if}
  {#if policyFailure}<p role="alert" class="problem">{policyFailure}</p>{/if}
  {#if !opened}<button type="button" onclick={()=>void open()} disabled={policyBusy}>Organize files</button>{/if}
  {#if complete}<p role="status">{complete}</p>{/if}
  {#if opened}
    {#if !plan}
      <label>Action <select bind:value={mode} disabled={busy||policyBusy}><option value="copy">Copy — keep the original</option><option value="move">Move — keep saved matches</option></select></label>
      <label>Destination folder <select bind:value={targetRootId} disabled={busy||policyBusy}><option value="" disabled>Choose a registered folder</option>{#each roots as root (root.id)}<option value={root.id}>{root.label}</option>{/each}</select></label>
      <p class="dim">Choose a registered folder in this library. Copy supports another volume; Move requires the same volume. Files already at the destination are never overwritten.</p>
      <button type="button" onclick={()=>void preview()} disabled={busy||policyBusy||!targetRootId}>{busy?'Preparing…':'Preview organization'}</button>
    {:else}
      <dl><dt>Action</dt><dd>{plan.mode==='move'?'Move':'Copy'}</dd><dt>From {roots.find((root)=>root.id===plan?.sourceRootId)?.label??'source folder'}</dt><dd><code>{plan.sourceRelativePath}</code></dd><dt>To {roots.find((root)=>root.id===plan?.targetRootId)?.label??'destination folder'}</dt><dd><code>{plan.targetRelativePath}</code></dd></dl>
      {#if plan.mode==='move'}<p>The original file will move to the previewed destination. Saved metadata and artwork stay with this game.</p>{:else}<p>The original file stays in place. The new copy receives the same saved metadata and artwork.</p>{/if}
      <button type="button" onclick={()=>void apply()} disabled={busy||policyBusy}>{busy?'Applying…':plan.mode==='move'?'Confirm move':'Confirm copy'}</button>
      <p class="dim">Optional automatic {plan.mode==='move'?'Move':'Copy'} applies to future successful saved metadata, artwork and system matches for eligible files in this source folder. Copy keeps one owned copy and updates its saved matches; Move keeps the game identity. Existing destinations are never overwritten. Move waits for suggested local metadata and artwork choices to be saved. Enabling changes no files now.</p>
      <button type="button" onclick={()=>void setAutomatic(true)} disabled={busy||policyBusy}>{policyBusy?'Enabling…':plan.mode==='move'?'Confirm automatic Move for this source folder':'Confirm automatic Copy for this source folder'}</button>
      <button type="button" onclick={()=>{plan=null;failure=null;}} disabled={busy||policyBusy}>Change options</button>
    {/if}
    <button type="button" onclick={cancel} disabled={busy||policyBusy}>Cancel</button>
  {/if}
  {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
</section>

<style>
  .organization {margin-block:1.5rem;padding-block:1rem;border-top:1px solid var(--border,#555);}
  label {display:block;margin-block:.75rem;}
  select {max-width:100%;margin-inline-start:.5rem;}
  button {margin:.25rem .5rem .25rem 0;}
  dd {margin-inline-start:0;margin-block-end:.75rem;overflow-wrap:anywhere;}
  dt {font-weight:600;}
</style>
{/if}
