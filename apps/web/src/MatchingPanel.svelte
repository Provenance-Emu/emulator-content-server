<script lang="ts">
  import { ContentError, type MatchingCandidate, type MatchingPlugin, type MatchingOptions } from '@ecs/client';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import type { ServerContext } from './lib/application';
  import { createMatching, type MatchingController } from './lib/matching';
  import { explain } from './lib/problems';
  import MatchingProviders from './components/MatchingProviders.svelte';
  import FormField from './components/FormField.svelte';
  import MatchMetadata from './components/MatchMetadata.svelte';
  import ListMore from './components/ListMore.svelte';
  import { shownLabel } from './lib/batches';
  import {artworkRoles,roleOf,matchSlot,matchLabel} from './lib/matching-slots';
  let {context,sourceId,sourceName,owner,onchanged,reviewOptions,onnext,onbusy,showLegacyPatchDownload=true,compact=false,controller:shared}:{context:ServerContext;sourceId:string;sourceName:string;owner:boolean;onchanged:()=>void;reviewOptions?:MatchingOptions;onnext?:()=>void;onbusy?:(busy:boolean)=>void;showLegacyPatchDownload?:boolean;
    /** One row per saved match instead of a card each. */
    compact?:boolean;
    /** The game page's own controller. It loads, reports failures and is disposed there. */
    controller?:MatchingController}=$props();
  const controller=untrack(()=>shared ?? createMatching(context.client,sourceId));
  let plugins=$state<MatchingPlugin[]>([]);
  let providerIds=$state<string[]>([]);
  let managerId=$state('org.ecs.matches');
  let online=$state(true);
  let checksum=$state(true);
  let failure=$state<string|null>(null);
  let registryFailure=$state<string|null>(null);
  let registryLoading=$state(false);
  let ready=$state(false);
  let disposed=false;
  let savedReady:Promise<void>=Promise.resolve();
  let lookupTitle = $state<string | undefined>();
  let lookupSystem = $state<string | undefined>();
  let lookupNotice = $state(false);
  let category=$state('metadata');
  let shown=$state(8);
  let artworkFilter=$state('all');
  const categories=[['metadata','Metadata'],['artwork','Artwork'],['patch','Patches'],['rom','System matching'],['cheats','Cheats']] as const;
  const candidates=$derived($controller.result?.candidates.filter((c)=>c.kind===category&&(category!=='artwork'||artworkFilter==='all'||roleOf(c)===artworkFilter)) ?? []);
  const visibleCandidates=$derived(candidates.slice(0,shown));
  $effect(()=>{
    if(category==='artwork'&&!$controller.suggestionsStale){
      for(const candidate of visibleCandidates)void controller.preview(candidate.id);
    }
  });
  const activeProviders=$derived(plugins.some((plugin)=>plugin.kind==='provider'&&providerIds.includes(plugin.id)&&(!plugin.network||online)));
  $effect(()=>{onbusy?.($controller.loading || $controller.savedLoading || !!$controller.saving);});
  const container=$derived(/\.(rar|m3u|ccd)$/i.test(sourceName));
  onMount(()=>{if(!shared)savedReady=controller.load();if(owner)void loadPlugins();});
  async function loadPlugins(){
    if(disposed||registryLoading)return;
    registryLoading=true;registryFailure=null;
    try {
      const registry=await context.client.matchingPlugins();
      if(disposed)return;
      plugins=registry.plugins;providerIds=plugins.filter((p)=>p.kind==='provider').map((p)=>p.id);ready=true;
      if(reviewOptions){await savedReady;if(!disposed)await find();}
    } catch(error){if(!disposed)registryFailure=explain(error);}
    finally {if(!disposed)registryLoading=false;}
  }
  onDestroy(()=>{disposed=true;if(!shared)controller.dispose();});
  async function save(id:string){if(await controller.save(id))onchanged();}
  async function saveLookupHints() {
    const saved = get(controller).saved?.lookupHints;
    lookupNotice = false;
    if (await controller.saveLookupHints({
      title: (lookupTitle ?? saved?.title ?? '').trim() || null,
      systemId: (lookupSystem ?? saved?.systemId ?? '').trim() || null,
    })) {
      lookupTitle = lookupSystem = undefined;
      lookupNotice = true;
      onchanged();
    }
  }
  function nextCategory(exclude?:string){
    const state=get(controller);
    return state.result?.candidates.find(c=>matchSlot(c)!==exclude&&!state.saved?.matches.some(m=>matchSlot(m)===matchSlot(c)))?.kind;
  }
  async function saveAndNext(id:string){
    if(!await controller.save(id)||disposed)return;
    onchanged();
    if(get(controller).suggestionsStale || get(controller).failure)return;
    const next=nextCategory();
    if(next){category=next;artworkFilter='all';shown=8;}
    else onnext?.();
  }
  async function remove(slot:string){if(await controller.remove(slot))onchanged();}
  async function downloadSaved(kind:string,name:string,role?:string){
    try {const blob=await context.client.selectedMatchContent(sourceId,kind,undefined,role);if(disposed)return;const url=URL.createObjectURL(blob);try{const link=document.createElement('a');link.href=url;link.download=name;link.click();}finally{URL.revokeObjectURL(url);}}
    catch(error){if(!disposed){if(error instanceof ContentError&&[401,403].includes(error.status))controller.invalidate();failure=explain(error);}}
  }
  async function find(){
    if(!activeProviders)return;
    shown=8;failure=null;
    await controller.find({online,checksum:checksum&&!container,providerIds,managerId,allowExactNames:true,autoSave:true});
    const state=get(controller);
    if(state.result?.automatic?.saved)onchanged();
    const suggestions=state.result?.candidates??[];
    const unsaved=reviewOptions?suggestions.find((c)=>!state.saved?.matches.some((m)=>matchSlot(m)===matchSlot(c))):null;
    if(unsaved)category=unsaved.kind;
    else if(!suggestions.some((c)=>c.kind===category))category=suggestions[0]?.kind??'metadata';
  }
  function providerName(id:string){if(id==='manual')return 'Edited by hand';return plugins.find((p)=>p.id===id)?.name ?? id;}
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

<section class="matching matching-page" aria-label="Metadata and artwork matching">
  <h2>Saved matches</h2>
  {#if $controller.savedLoading}<p role="status">Loading saved matches…</p>{/if}
  {#if (shared||compact) && $controller.saved?.matches.length}
    <!-- The game page already shows the pictures and details; this is the list of what is kept. -->
    <ul class="saved-rows">{#each $controller.saved.matches as selected (matchSlot(selected))}
      {@const art=selected.kind==='artwork'?(roleOf(selected)==='front'?$controller.savedArtwork:$controller.savedArtworkByRole[roleOf(selected)]):null}
      <li>
        {#if art}<img src={art} alt={'Saved artwork for '+selected.title} />{:else}<span class="saved-thumb" aria-hidden="true"></span>{/if}
        <span class="saved-name"><strong>{selected.kind==='metadata'?'Details':selected.kind==='rom'?'System match':matchLabel(selected)}</strong>
          <span class="dim">{selected.providerId==='manual'?'Edited by hand':providerName(selected.providerId)}{#if selected.kind==='cheats'} · codes stay off until you choose them in your player{/if}</span></span>
        {#if selected.contentAvailable && (selected.kind!=='patch' || showLegacyPatchDownload)}<button type="button" class="text-button" aria-label={`Download ${matchLabel(selected)}`} onclick={()=>void downloadSaved(selected.kind,selected.fileName??'selected',selected.kind==='artwork'?roleOf(selected):undefined)}>Download</button>{/if}
        {#if owner}<button type="button" class="text-button" aria-label={`Remove saved ${matchLabel(selected)}`} disabled={!!$controller.saving||$controller.loading||$controller.savedLoadFailed||$controller.savedLoading} onclick={()=>void remove(matchSlot(selected))}>Remove</button>{/if}
      </li>
    {/each}</ul>
  {:else if $controller.saved?.matches.length}
    <div class="matching-card-grid">{#each $controller.saved.matches as selected (matchSlot(selected))}
      <article class="matching-card"><h3>{selected.title}</h3><p class="dim">{selected.providerId==='manual'?'Edited by hand':`${matchLabel(selected)} · ${providerName(selected.providerId)}`}</p>
        {#if selected.kind==='artwork' && (roleOf(selected)==='front'?$controller.savedArtwork:$controller.savedArtworkByRole[roleOf(selected)])}<img src={(roleOf(selected)==='front'?$controller.savedArtwork:$controller.savedArtworkByRole[roleOf(selected)])??''} alt={'Saved artwork for '+selected.title} />
        {:else}<MatchMetadata metadata={selected.metadata} />{/if}
        {#if selected.kind==='cheats'}<p class="dim">All codes in the saved file are disabled. Choose compatible codes in your player.</p>{/if}
        {#if selected.kind==='artwork'&&roleOf(selected)!=='front'&&selected.contentType?.startsWith('image/')&&!$controller.savedArtworkByRole[roleOf(selected)]}<button type="button" onclick={()=>void controller.previewSaved(roleOf(selected))}>Preview {matchLabel(selected)}</button>{/if}
        {#if selected.contentAvailable && (selected.kind!=='patch' || showLegacyPatchDownload)}<button type="button" onclick={()=>void downloadSaved(selected.kind,selected.fileName??'selected',selected.kind==='artwork'?roleOf(selected):undefined)}>Download {matchLabel(selected)}</button>{/if}
        {#if owner}<button type="button" disabled={!!$controller.saving||$controller.loading||$controller.savedLoadFailed||$controller.savedLoading} onclick={()=>void remove(matchSlot(selected))}>Remove saved {matchLabel(selected)}</button>{/if}
      </article>
    {/each}</div>
  {:else if $controller.saved && !$controller.savedLoading}<p class="dim">No matches have been saved for this game.</p>{/if}
  {#if $controller.savedLoadFailed}<button type="button" disabled={$controller.loading||$controller.savedLoading||!!$controller.saving} onclick={()=>void controller.load()}>Retry saved matches</button>{/if}
  {#if failure||(!shared&&$controller.failure)}<p role="alert" class="problem">{failure ?? $controller.failure}</p>{/if}
  {#if registryFailure}<p role="alert" class="problem">{registryFailure}</p><button type="button" disabled={registryLoading} onclick={()=>void loadPlugins()}>Retry matching providers</button>{/if}
  {#if owner}
  {#if $controller.saved?.lookupHints}
    <details class="matching-disclosure">
      <summary>Improve lookup</summary>
      <form class="matching-disclosure-content matching-fields" onsubmit={(event) => { event.preventDefault(); void saveLookupHints(); }}>
        <p>Give the server a better title or system for this game. Changed hints trigger another lookup when automatic lookup is on.</p>
        <label>Game title for lookup<input maxlength="160" value={lookupTitle ?? $controller.saved.lookupHints.title ?? ''} oninput={(event) => { lookupNotice = false; lookupTitle = event.currentTarget.value; }} /></label>
        <label>System identifier<input maxlength="120" placeholder="com.provenance.nes" value={lookupSystem ?? $controller.saved.lookupHints.systemId ?? ''} oninput={(event) => { lookupNotice = false; lookupSystem = event.currentTarget.value; }} /></label>
        <button type="submit" disabled={$controller.loading || $controller.savedLoading || $controller.savedLoadFailed || !!$controller.saving}>Save lookup hints</button>
        {#if lookupNotice}<p role="status">Lookup hints saved.</p>{/if}
      </form>
    </details>
  {/if}
  <h2>Look up this game</h2>
  <p class="dim">A match that is certain is saved on its own. Anything doubtful is listed below for you to choose.</p>
  <div class="matching-actions" aria-label="Matching actions">
    <button type="button" class="primary" disabled={!ready||$controller.loading||$controller.savedLoading||!!$controller.saving||!activeProviders} onclick={()=>void find()}>{$controller.loading ? 'Finding matches…' : 'Find matches'}</button>
    {#if $controller.result}<button type="button" disabled={!!$controller.saving} onclick={()=>controller.clear()}>Clear matches</button>{/if}
  </div>
  <details class="matching-disclosure matching-options-disclosure">
    <summary>Matching options</summary>
    <div class="matching-disclosure-content matching-fields">
      <label class="matching-check"><input type="checkbox" bind:checked={checksum} disabled={container || $controller.loading} /> Read game IDs and verify hashes</label>
      <MatchingProviders {plugins} bind:online bind:providerIds bind:managerId disabled={$controller.loading||!!$controller.saving} />
      <p class="dim">Identification plugins read bounded ROM or disc data. Supported archives verify the inner ROM; CHD header hashes are labelled separately from verified content. Online providers use public Libretro catalogs and cheat indexes. ROM bytes and server paths stay on this machine.
      {#if /\.zip$/i.test(sourceName)} A ZIP can be verified when it contains one supported ROM. Ambiguous or unsupported archives keep filename suggestions.{/if}
      {#if container} This disc layout uses filename suggestions until a supported identification plugin can read it.{/if}</p>
      {#if ready&&!activeProviders}<p class="form-help">Select a local provider or include an online provider before matching.</p>{/if}
    </div>
  </details>


  {#if $controller.result}
    {#if $controller.result.automatic?.saved}<p role="status">Saved {$controller.result.automatic.saved} {$controller.result.automatic.saved===1?'match':'matches'} automatically.</p>{/if}
    {#each $controller.result.problems as problem}<p class="problem">{providerName(problem.providerId).split(' · ')[0]} could not be reached. Other results are still shown.</p>{/each}
    <div class="actions matching-tabs" aria-label="Match categories">
      {#each categories as [id,label]}<button type="button" class:active={category===id} aria-pressed={category===id} onclick={()=>{category=id;shown=8;}}>{label} ({$controller.result.candidates.filter((c)=>c.kind===id).length})</button>{/each}
    </div>
    {#if !candidates.length}<p>No {categories.find(([id])=>id===category)?.[1]?.toLowerCase()} suggestions from the selected providers.</p>{/if}
    {#if category==='artwork'}<div class="matching-field"><FormField label="Artwork type">{#snippet children(attributes)}<select {...attributes} bind:value={artworkFilter} onchange={()=>shown=8}><option value="all">All artwork</option>{#each artworkRoles as [role,label]}<option value={role}>{label}</option>{/each}</select>{/snippet}</FormField></div>{/if}
    <div class="matching-card-grid">
      {#each visibleCandidates as candidate (candidate.id)}
        <article class="matching-card">
          <h3>{candidate.title}</h3>
          <p class="dim">{providerName(candidate.providerId)} · {candidate.kind==='artwork'?matchLabel(candidate)+' · ':''} {candidate.metadata.matchEvidence==='saved-selection'?'Matches saved game details':candidate.metadata.matchEvidence==='exact-name'?'Exact filename and edition':candidate.metadata.matchEvidence==='verified-serial'?'Verified disc ID':candidate.metadata.matchEvidence==='declared-hash'?'Declared container hash — content not reread':candidate.metadata.matchEvidence==='hash-conflict'?'Conflicting checksums — review':candidate.confidence==='checksum' ? 'Verified checksum' : candidate.confidence==='local' ? 'Local filename association' : 'Filename suggestion — verify the edition'}</p>
          {#if candidate.kind==='artwork'&&candidate.metadata.imageKind!=='pdf'}
            {#if $controller.artwork[candidate.id]}<img src={$controller.artwork[candidate.id]} alt={'Artwork suggestion for '+candidate.title} />
            {:else if $controller.artworkFailures[candidate.id]}<p class="dim">{$controller.artworkFailures[candidate.id]}</p>
            {:else if !$controller.suggestionsStale}<p class="dim">Loading artwork…</p>{/if}
          {:else}<MatchMetadata metadata={candidate.metadata} />{/if}
          <button type="button" disabled={$controller.suggestionsStale||!$controller.saved||!!$controller.saving||$controller.savedLoadFailed||$controller.savedLoading||$controller.saved.matches.some((m)=>m.id===candidate.id)} onclick={()=>void save(candidate.id)}>{$controller.saving===candidate.id ? 'Saving…' : $controller.saved?.matches.some((m)=>m.id===candidate.id) ? 'Saved' : $controller.saved?.matches.some((m)=>matchSlot(m)===matchSlot(candidate)) ? 'Replace saved '+matchLabel(candidate) : 'Save '+matchLabel(candidate)}</button>
          {#if onnext}<button type="button" disabled={$controller.suggestionsStale||!$controller.saved||!!$controller.saving||$controller.loading||$controller.savedLoadFailed||$controller.savedLoading||$controller.saved.matches.some((m)=>m.id===candidate.id)} onclick={()=>void saveAndNext(candidate.id)}>{nextCategory(matchSlot(candidate))?'Save and next category':'Save and next game'}</button>{/if}
          {#if candidate.kind==='patch'&&candidate.fileId}<button type="button" onclick={()=>void download(candidate)}>Download patch</button>{/if}
        </article>
      {/each}
    </div>
    {#if candidates.length>8}<ListMore label={shownLabel(visibleCandidates.length,shown<candidates.length,['match','matches'],candidates.length)} more={shown<candidates.length} auto={false} action="Show more matches" onmore={()=>shown+=8} />{/if}
  {/if}
  {/if}
</section>

<style>
  .matching { margin-top:var(--space-6); border-top:var(--border-width) solid var(--line); padding-top:var(--space-4); }
  h3 { margin-top:0; }
  .matching-card > button { margin:var(--space-1) var(--space-1) 0 0; }
  img { display:block; width:100%; max-width:18rem; max-height:24rem; object-fit:contain; }
  .saved-rows { display:grid; gap:var(--space-1); margin:0 0 var(--space-4); padding:0; list-style:none; }
  .saved-rows li { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-1) var(--space-3); min-height:var(--control-height-touch); }
  .saved-rows img, .saved-thumb { flex:none; width:2.25rem; height:2.25rem; max-width:none; border-radius:var(--radius-sm); object-fit:cover; background:var(--color-surface-inset); }
  .saved-name { display:flex; flex:1 1 12rem; flex-wrap:wrap; gap:0 var(--space-2); min-width:0; }
  .saved-name strong::first-letter { text-transform:uppercase; }
  .saved-name .dim { font-size:var(--text-small); }
</style>
