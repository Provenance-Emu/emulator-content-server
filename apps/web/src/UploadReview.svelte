<script lang="ts">
  import type { ContentClient, SystemSummary } from '@ecs/client';
  import type { UploadReview } from './lib/upload-review';
  import { KIND_ORDER, kindLabel } from './lib/content-format';
  import UploadTargetPicker from './UploadTargetPicker.svelte';
  let {
    controller,
    systems,
    client,
    libraryId,
  }: {
    controller: UploadReview;
    systems: SystemSummary[];
    client: ContentClient;
    libraryId: string;
  } = $props();
  let commonKind = $state('');
  let commonSystem = $state('');
  let picking = $state<string | null>(null);
</script>
<section aria-label="Upload review">
  <h3>Review selected files ({$controller.entries.length})</h3>
  <div class="form-grid">
    <label>Kind for all files<select bind:value={commonKind} onchange={()=>{if(commonKind)controller.setCommonMetadata({kind:commonKind});}}><option value="">Choose a kind</option>{#each KIND_ORDER as kind}<option value={kind}>{kindLabel(kind)}</option>{/each}</select></label>
    <label>System<select bind:value={commonSystem} onchange={()=>{if(commonSystem)controller.setCommonMetadata({system:commonSystem});}}><option value="">Choose a system</option>{#each systems as system}<option value={system.identifier}>{system.name}</option>{/each}</select></label>
  </div>
  {#if $controller.entries.some(e=>e.kind && e.kind!=='rom')}<button type="button" onclick={()=>picking='all'}>Choose target for associated files</button>{/if}
  {#if picking}<UploadTargetPicker {client} {libraryId} oncancel={()=>picking=null} onchoose={(target)=>{if(picking==='all'){controller.setCommonMetadata({target});}else if(picking){controller.setEntryMetadata(picking,{target});}picking=null;}} />{/if}
  <ol start={$controller.page*50+1} class="upload-entries">
    {#each $controller.visible as entry (entry.id)}
      <li>
        <p><strong>{entry.file.name}</strong> · {entry.relativePath}</p>
        <div class="form-grid">
          <label>Title for {entry.file.name}<input value={entry.title} onchange={event=>controller.setEntryMetadata(entry.id,{title:event.currentTarget.value})} /></label>
          <label>Kind for {entry.file.name}<select value={entry.kind} onchange={event=>controller.setEntryMetadata(entry.id,{kind:event.currentTarget.value})}><option value="">Choose a kind</option>{#each KIND_ORDER as kind}<option value={kind}>{kindLabel(kind)}</option>{/each}</select></label>
          {#if entry.kind==='rom' && !entry.target}<label>System for {entry.file.name}<select value={entry.system} onchange={event=>controller.setEntryMetadata(entry.id,{system:event.currentTarget.value})}><option value="">Choose a system</option>{#each systems as system}<option value={system.identifier}>{system.name}</option>{/each}</select></label>{/if}
        </div>
        {#if entry.target}<p>Target: {entry.target.title} · ID {entry.target.id}</p>{:else if entry.kind==='rom'}<p>Creates a new managed item.</p>{/if}
        {#if entry.kind && entry.kind!=='rom'}<button type="button" onclick={()=>picking=entry.id}>Choose target for {entry.file.name}</button>{/if}
        {#each entry.errors as error}<p class="problem">{error}</p>{/each}
      </li>
    {/each}
  </ol>
  <nav aria-label="Review pages"><button type="button" disabled={$controller.page===0} onclick={()=>controller.page($controller.page-1)}>Previous files</button><span>Page {$controller.page+1} of {$controller.pages}</span><button type="button" disabled={$controller.page+1===$controller.pages} onclick={()=>controller.page($controller.page+1)}>Next files</button></nav>
</section>
<style>
  .upload-entries { padding-inline-start: 1.5rem; }
  .upload-entries li { padding: 1rem 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,12rem),1fr)); gap: .75rem; }
  nav { display:flex; flex-wrap:wrap; gap:.75rem; align-items:center; margin-block:1rem; }
</style>
