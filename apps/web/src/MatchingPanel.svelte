<script lang="ts">
  import { ContentError, type MatchingCandidate, type MatchingPlugin, type MatchingOptions } from '@ecs/client';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import type { ServerContext } from './lib/application';
  import { createMatching } from './lib/matching';
  import { explain } from './lib/problems';
  import MatchingProviders from './components/MatchingProviders.svelte';
  import FormField from './components/FormField.svelte';
  import {artworkRoles,roleOf,matchSlot,matchLabel} from './lib/matching-slots';
  let {context,sourceId,sourceName,owner,onchanged,reviewOptions,onnext,onbusy}:{context:ServerContext;sourceId:string;sourceName:string;owner:boolean;onchanged:()=>void;reviewOptions?:MatchingOptions;onnext?:()=>void;onbusy?:(busy:boolean)=>void}=$props();
  const controller=untrack(()=>createMatching(context.client,sourceId));
  let plugins=$state<MatchingPlugin[]>([]);
  let providerIds=$state<string[]>([]);
  let managerId=$state('org.ecs.matches');
  let online=$state(false);
  let checksum=$state(false);
  let failure=$state<string|null>(null);
  let registryFailure=$state<string|null>(null);
  let registryLoading=$state(false);
  let ready=$state(false);
  let disposed=false;
  let savedReady:Promise<void>=Promise.resolve();
  let category=$state('metadata');
  let page=$state(0);
  let artworkFilter=$state('all');
  const categories=[['metadata','Metadata'],['artwork','Artwork'],['patch','Patches'],['rom','System matching'],['cheats','Cheats']] as const;
  const candidates=$derived($controller.result?.candidates.filter((c)=>c.kind===category&&(category!=='artwork'||artworkFilter==='all'||roleOf(c)===artworkFilter)) ?? []);
  const activeProviders=$derived(plugins.some((plugin)=>plugin.kind==='provider'&&providerIds.includes(plugin.id)&&(!plugin.network||online)));
  $effect(()=>{onbusy?.($controller.loading || $controller.savedLoading || !!$controller.saving);});
  const container=$derived(/\.(rar|cue|m3u|gdi|ccd)$/i.test(sourceName));
  onMount(()=>{savedReady=controller.load();if(owner)void loadPlugins();});
  async function loadPlugins(){
    if(disposed||registryLoading)return;
    registryLoading=true;registryFailure=null;
    try {
      const registry=await context.client.matchingPlugins();
      if(disposed)return;
      plugins=registry.plugins;providerIds=reviewOptions?.providerIds??plugins.filter((p)=>p.kind==='provider').map((p)=>p.id);ready=true;
      if(reviewOptions){online=reviewOptions.online===true;checksum=reviewOptions.checksum===true;managerId=reviewOptions.managerId??'org.ecs.matches';await savedReady;if(!disposed)await find();}
    } catch(error){if(!disposed)registryFailure=explain(error);}
    finally {if(!disposed)registryLoading=false;}
  }
  onDestroy(()=>{disposed=true;controller.dispose();});
  async function save(id:string){if(await controller.save(id))onchanged();}
  function nextCategory(exclude?:string){
    const state=get(controller);
    return state.result?.candidates.find(c=>matchSlot(c)!==exclude&&!state.saved?.matches.some(m=>matchSlot(m)===matchSlot(c)))?.kind;
  }
  async function saveAndNext(id:string){
    if(!await controller.save(id)||disposed)return;
    onchanged();
    if(get(controller).suggestionsStale || get(controller).failure)return;
    const next=nextCategory();
    if(next){category=next;artworkFilter='all';page=0;}
    else onnext?.();
  }
  async function remove(slot:string){if(await controller.remove(slot))onchanged();}
  async function downloadSaved(kind:string,name:string,role?:string){
    try {const blob=await context.client.selectedMatchContent(sourceId,kind,undefined,role);if(disposed)return;const url=URL.createObjectURL(blob);try{const link=document.createElement('a');link.href=url;link.download=name;link.click();}finally{URL.revokeObjectURL(url);}}
    catch(error){if(!disposed){if(error instanceof ContentError&&[401,403].includes(error.status))controller.invalidate();failure=explain(error);}}
  }
  async function find(){
    if(!activeProviders)return;
    page=0;failure=null;
    await controller.find({online,checksum:checksum&&!container,providerIds,managerId,allowExactNames:reviewOptions?.allowExactNames??false});
    const state=get(controller);
    const suggestions=state.result?.candidates??[];
    const unsaved=reviewOptions?suggestions.find((c)=>!state.saved?.matches.some((m)=>matchSlot(m)===matchSlot(c))):null;
    if(unsaved)category=unsaved.kind;
    else if(!suggestions.some((c)=>c.kind===category))category=suggestions[0]?.kind??'metadata';
  }
  function providerName(id:string){return plugins.find((p)=>p.id===id)?.name ?? id;}
  async function download(candidate:MatchingCandidate){
    if(!candidate.fileId)return;
    try {
      const result=await context.client.collectSource(candidate.fileId,{maxBytes:2*1024*1024});
      if(disposed)return;
      const url=URL.createObjectURL(new Blob([result.bytes],{type:'application/octet-stream'}));
      try {const link=document.createElement('a');link.href=url;link.download=candidate.title+'.'+(candidate.metadata.format ?? 'patch');link.click();} finally {URL.revokeObjectURL(url);}
    } catch(error){if(!disposed){if(error instanceof ContentError && [401,403,404].includes(error.status))controller.invalidate();failure=explain(error);}}
  }
</script>

<section class="matching" aria-label="Metadata and artwork matching">
  <h2>Saved matches</h2>
  {#if $controller.savedLoading}<p role="status">Loading saved matches…</p>{/if}
  {#if $controller.saved?.matches.length}
    <div class="match-results">{#each $controller.saved.matches as selected (matchSlot(selected))}
      <article><h3>{selected.title}</h3><p class="dim">{matchLabel(selected)} · {providerName(selected.providerId)}</p>
        {#if selected.kind==='artwork' && (roleOf(selected)==='front'?$controller.savedArtwork:$controller.savedArtworkByRole[roleOf(selected)])}<img src={(roleOf(selected)==='front'?$controller.savedArtwork:$controller.savedArtworkByRole[roleOf(selected)])??''} alt={'Saved artwork for '+selected.title} />
        {:else}<dl>{#each Object.entries(selected.metadata) as [key,value]}<dt>{key}</dt><dd>{String(value)}</dd>{/each}</dl>{/if}
        {#if selected.kind==='cheats'}<p class="dim">All codes in the saved file are disabled. Choose compatible codes in your player.</p>{/if}
        {#if selected.kind==='artwork'&&roleOf(selected)!=='front'&&selected.contentType?.startsWith('image/')&&!$controller.savedArtworkByRole[roleOf(selected)]}<button type="button" onclick={()=>void controller.previewSaved(roleOf(selected))}>Preview {matchLabel(selected)}</button>{/if}
        {#if selected.contentAvailable}<button type="button" onclick={()=>void downloadSaved(selected.kind,selected.fileName??'selected',selected.kind==='artwork'?roleOf(selected):undefined)}>Download {matchLabel(selected)}</button>{/if}
        {#if owner}<button type="button" disabled={!!$controller.saving||$controller.loading||$controller.savedLoadFailed||$controller.savedLoading} onclick={()=>void remove(matchSlot(selected))}>Remove saved {matchLabel(selected)}</button>{/if}
      </article>
    {/each}</div>
  {:else if $controller.saved && !$controller.savedLoading}<p class="dim">No matches have been saved for this game.</p>{/if}
  {#if $controller.savedLoadFailed}<button type="button" disabled={$controller.loading||$controller.savedLoading||!!$controller.saving} onclick={()=>void controller.load()}>Retry saved matches</button>{/if}
  {#if failure||$controller.failure}<p role="alert" class="problem">{failure ?? $controller.failure}</p>{/if}
  {#if registryFailure}<p role="alert" class="problem">{registryFailure}</p><button type="button" disabled={registryLoading} onclick={()=>void loadPlugins()}>Retry matching providers</button>{/if}
  {#if owner}
  <h2>Find metadata, artwork, patches & cheats</h2>
  <p class="dim">Find suggestions from files beside this game and your selected providers. Save a choice to keep it with this game. Saving metadata makes its title and details visible to people who can read the game. Your original files stay unchanged.</p>
  <div class="match-options">
    <label><input type="checkbox" bind:checked={checksum} disabled={container || $controller.loading} /> Read game IDs and verify hashes</label>
  </div>
  <p class="dim">Identification plugins read bounded ROM or disc data. Supported archives verify the inner ROM; CHD header hashes are labelled separately from verified content.</p>
  <p class="dim">Online providers use public Libretro catalogs and cheat indexes. Artwork loads when you choose Preview. ROM bytes and server paths stay on this machine.</p>
  {#if /\.zip$/i.test(sourceName)}<p class="dim">A ZIP can be verified when it contains one supported ROM. Ambiguous or unsupported archives keep filename suggestions.</p>{/if}
  {#if container}<p class="dim">This disc layout uses filename suggestions until a supported identification plugin can read it.</p>{/if}
  <MatchingProviders {plugins} bind:online bind:providerIds bind:managerId disabled={$controller.loading||!!$controller.saving} />
  {#if ready&&!activeProviders}<p class="dim">Select a local provider or enable a selected online provider before matching.</p>{/if}
  <button type="button" disabled={!ready||$controller.loading||$controller.savedLoading||!!$controller.saving||!activeProviders} onclick={()=>void find()}>{$controller.loading ? 'Finding matches…' : 'Find matches'}</button>
  {#if $controller.result}<button type="button" disabled={!!$controller.saving} onclick={()=>controller.clear()}>Clear matches</button>{/if}

  {#if $controller.result}
    {#each $controller.result.problems as problem}<p class="problem">{providerName(problem.providerId)} could not complete its lookup. Other results are still available.</p>{/each}
    <div class="actions" aria-label="Match categories">
      {#each categories as [id,label]}<button type="button" class:active={category===id} aria-pressed={category===id} onclick={()=>{category=id;page=0;}}>{label} ({$controller.result.candidates.filter((c)=>c.kind===id).length})</button>{/each}
    </div>
    {#if !candidates.length}<p>No {categories.find(([id])=>id===category)?.[1]?.toLowerCase()} suggestions from the selected providers.</p>{/if}
    {#if category==='artwork'}<FormField label="Artwork type">{#snippet children(attributes)}<select {...attributes} bind:value={artworkFilter} onchange={()=>page=0}><option value="all">All artwork</option>{#each artworkRoles as [role,label]}<option value={role}>{label}</option>{/each}</select>{/snippet}</FormField>{/if}
    <div class="match-results">
      {#each candidates.slice(page*8,page*8+8) as candidate (candidate.id)}
        <article>
          <h3>{candidate.title}</h3>
          <p class="dim">{providerName(candidate.providerId)} · {candidate.kind==='artwork'?matchLabel(candidate)+' · ':''} {candidate.metadata.matchEvidence==='exact-name'?'Exact filename and edition':candidate.metadata.matchEvidence==='verified-serial'?'Verified disc ID':candidate.metadata.matchEvidence==='declared-hash'?'Declared container hash — content not reread':candidate.metadata.matchEvidence==='hash-conflict'?'Conflicting checksums — review':candidate.confidence==='checksum' ? 'Verified checksum' : candidate.confidence==='local' ? 'Local filename association' : 'Filename suggestion — verify the edition'}</p>
          {#if candidate.kind==='artwork'&&candidate.metadata.imageKind!=='pdf'}
            {#if $controller.artwork[candidate.id]}<img src={$controller.artwork[candidate.id]} alt={'Artwork suggestion for '+candidate.title} />
            {:else}<button type="button" disabled={!!$controller.previewing} onclick={()=>void controller.preview(candidate.id)}>{$controller.previewing===candidate.id ? 'Loading preview…' : 'Preview artwork'}</button>{/if}
          {:else}<dl>{#each Object.entries(candidate.metadata) as [key,value]}<dt>{key}</dt><dd>{String(value)}</dd>{/each}</dl>{/if}
          <button type="button" disabled={$controller.suggestionsStale||!$controller.saved||!!$controller.saving||$controller.savedLoadFailed||$controller.savedLoading||$controller.saved.matches.some((m)=>m.id===candidate.id)} onclick={()=>void save(candidate.id)}>{$controller.saving===candidate.id ? 'Saving…' : $controller.saved?.matches.some((m)=>m.id===candidate.id) ? 'Saved' : $controller.saved?.matches.some((m)=>matchSlot(m)===matchSlot(candidate)) ? 'Replace saved '+matchLabel(candidate) : 'Save '+matchLabel(candidate)}</button>
          {#if onnext}<button type="button" disabled={$controller.suggestionsStale||!$controller.saved||!!$controller.saving||$controller.loading||$controller.savedLoadFailed||$controller.savedLoading||$controller.saved.matches.some((m)=>m.id===candidate.id)} onclick={()=>void saveAndNext(candidate.id)}>{nextCategory(matchSlot(candidate))?'Save and next category':'Save and next game'}</button>{/if}
          {#if candidate.kind==='patch'&&candidate.fileId}<button type="button" onclick={()=>void download(candidate)}>Download patch</button>{/if}
        </article>
      {/each}
    </div>
    {#if candidates.length>8}<div class="actions"><button type="button" disabled={page===0} onclick={()=>page--}>Previous matches</button><span>Page {page+1}</span><button type="button" disabled={(page+1)*8>=candidates.length} onclick={()=>page++}>Next matches</button></div>{/if}
  {/if}
  {/if}
</section>

<style>
  .matching { margin-top:2rem; border-top:1px solid var(--border, #444); padding-top:1rem; }
  .match-options { display:flex; flex-wrap:wrap; gap:1rem; margin:1rem 0; }
  .match-results { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr)); gap:1rem; margin:1rem 0; }
  article { border:1px solid var(--border,#444); padding:1rem; border-radius:.6rem; overflow-wrap:anywhere; }
  h3 { margin-top:0; }
  img { display:block; width:100%; max-width:18rem; max-height:24rem; object-fit:contain; }
  dt { font-weight:600; text-transform:capitalize; }
  dd { margin:0 0 .6rem; white-space:pre-wrap; }
  .active { outline:2px solid currentColor; }
</style>
