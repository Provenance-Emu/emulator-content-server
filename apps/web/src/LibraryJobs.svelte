<script lang="ts">
  import type { LibraryScope, MatchingPlugin, LibraryJobItem, Library, ContentRootSummary, LibraryJobScope } from '@ecs/client';
  import { onMount, untrack } from 'svelte';
  import type { ServerContext } from './lib/application';
  import { createLibraryJobs } from './lib/library-jobs';
  import { canChecksum } from './lib/bulk-matching';
  import { explain } from './lib/problems';
  import MatchingProviders from './components/MatchingProviders.svelte';
  import MatchingPanel from './MatchingPanel.svelte';
  let {context,scope,onchanged,libraries=[],roots=[]}:{context:ServerContext;scope:LibraryScope;onchanged:()=>void;libraries?:Library[];roots?:ContentRootSummary[]}=$props();
  const controller=untrack(()=>createLibraryJobs(context.client,scope,{changed:onchanged}));
  let plugins=$state<MatchingPlugin[]>([]),providerIds=$state<string[]>([]),online=$state(true),managerId=$state('org.ecs.matches');
  let registryFailure=$state<string|null>(null),ready=$state(false),reviewing=$state<LibraryJobItem|null>(null);
  let filter=$state('review');
  let reviewBusy=$state(false);
  const selected=$derived($controller.jobs.find(job=>job.id===$controller.selectedId));
  const active=$derived(selected&&['queued','running'].includes(selected.state));
  const canMatch=$derived(ready&&plugins.some(p=>p.kind==='provider'&&providerIds.includes(p.id)&&(!p.network||online)));
  function scopeName(selected:LibraryJobScope){
    if(selected.rootId)return roots.find(row=>row.root.id===selected.rootId)?.root.label??'Saved folder';
    if(selected.libraryId)return libraries.find(library=>library.id===selected.libraryId)?.name??'Library';
    return selected.unassigned?'Unassigned folders':'All libraries';
  }
  function itemName(item:LibraryJobItem){return item.source?.name??roots.find(row=>row.root.id===item.sourceId)?.root.label??'Unavailable source';}
  let live=false,registryLoading=$state(false);
  onMount(()=>{live=true;controller.connect();void loadProviders();return()=>{live=false;controller.dispose();};});
  async function loadProviders(){
    if(!live||registryLoading)return;
    registryLoading=true;registryFailure=null;
    try {
      const result=await context.client.matchingPlugins();if(!live)return;
      plugins=result.plugins;providerIds=plugins.filter(p=>p.kind==='provider'&&(!p.network||!p.capabilities.includes('cheats'))).map(p=>p.id);ready=true;
    }catch(error){if(live){registryFailure=explain(error);ready=false;}}
    finally{if(live)registryLoading=false;}
  }
  async function choose(id:string){reviewing=null;await controller.choose(id);await controller.filter(filter);}
  async function start(kind:'scan'|'match'){reviewing=null;await controller.start(kind,kind==='match'?{online,providerIds,managerId,checksum:true}:{});await controller.filter(filter);}
  async function nextReview(done:boolean) {
    if(!reviewing||reviewBusy)return;
    reviewBusy=true;
    try {
      const id=reviewing.sourceId;
      const next=$controller.items.find(item=>item.sourceId!==id&&['review','unmatched','failed'].includes(item.status));
      if(done){await controller.reviewed(id);if($controller.failure)return;}
      if(next)reviewing=next;
      else if($controller.nextCursor){await controller.next();reviewing=$controller.items.find(item=>['review','unmatched','failed'].includes(item.status))??null;}
      else reviewing=null;
    }finally{reviewBusy=false;}
  }
</script>

<p>Library work runs on the server and is shared across your sessions. You can close this window and return later.</p>
<div class="actions" aria-label="Start library work">
  <button type="button" class="primary" disabled={$controller.loading||!canMatch} onclick={()=>void start('match')}>Find missing artwork and details</button>
  <button type="button" disabled={$controller.loading} onclick={()=>void start('scan')}>Scan saved folders</button>
  <button type="button" disabled={$controller.loading} onclick={()=>void controller.refresh()}>Refresh activity</button>
</div>
<details><summary>Matching providers</summary><MatchingProviders {plugins} bind:online bind:providerIds bind:managerId disabled={$controller.loading} /></details>
<p class="dim">Saved choices stay intact. Unique checksum matches can save automatically; filename suggestions and conflicting matches need review. Unavailable files are skipped without downloading cloud placeholders.</p>
{#if registryFailure||$controller.failure}<p role="alert" class="problem">{registryFailure??$controller.failure}</p>{/if}
{#if registryFailure}<button type="button" disabled={registryLoading} onclick={()=>void loadProviders()}>Retry matching providers</button>{/if}

{#if $controller.jobs.length}
  <label>Server activity<select value={$controller.selectedId??''} onchange={event=>void choose(event.currentTarget.value)}>
    {#each $controller.jobs as job(job.id)}<option value={job.id}>{scopeName(job.scope)} · {job.kind==='scan'?'Folder scan':'Artwork and metadata'} · {job.state} · {job.processed}/{job.total} · {new Date(job.createdAt).toLocaleString()}</option>{/each}
  </select></label>
{:else}<p>No library jobs yet.</p>{/if}
{#if selected}
  <section aria-label="Library job progress">
    <p role="status">{selected.state} · {selected.processed.toLocaleString()} of {selected.total.toLocaleString()} checked</p>
    <progress max={Math.max(1,selected.total)} value={selected.processed} aria-label="Library job progress"></progress>
    <p class="dim">{selected.saved.toLocaleString()} selections saved · {selected.review.toLocaleString()} need review · {selected.unmatched.toLocaleString()} without a match · {selected.failed.toLocaleString()} failed · {selected.skipped.toLocaleString()} skipped</p>
    {#if selected.error}<p class="problem">{selected.error}</p>{/if}
    <div class="actions">
      {#if active}<button type="button" disabled={$controller.loading} onclick={()=>void controller.cancel(selected.id)}>Cancel job</button>
      {:else if ['cancelled','interrupted','failed'].includes(selected.state)}<button type="button" disabled={$controller.loading} onclick={()=>void controller.resume(selected.id)}>Resume remaining work</button>{/if}
      {#if !active&&selected.failed}<button type="button" disabled={$controller.loading} onclick={()=>void controller.resume(selected.id,'failed')}>Retry failed games</button>{/if}
      {#if !active&&selected.unmatched}<button type="button" disabled={$controller.loading} onclick={()=>void controller.resume(selected.id,'unmatched')}>Retry unmatched games</button>{/if}
    </div>
  </section>
  {#if reviewing&&selected.kind==='match'}
    <button type="button" disabled={reviewBusy} onclick={()=>reviewing=null}>Back to job results</button>
    <button type="button" disabled={reviewBusy} onclick={()=>void nextReview(true)}>Done reviewing this game</button>
    <button type="button" disabled={reviewBusy} onclick={()=>void nextReview(false)}>Next unresolved game</button>
    <h3>{itemName(reviewing)}</h3>
    {#key reviewing.sourceId}<MatchingPanel {context} owner={true} {onchanged} sourceId={reviewing.sourceId} sourceName={itemName(reviewing)} reviewOptions={{...selected.options,checksum:reviewing.source?canChecksum(reviewing.source):false}} onnext={()=>void nextReview(true)} />{/key}
  {:else}
    <label>Results<select bind:value={filter} onchange={()=>void controller.filter(filter)}><option value="review">Needs review</option><option value="failed">Failed</option><option value="unmatched">No match</option><option value="saved">Saved</option><option value="skipped">Skipped</option><option value="">All results</option></select></label>
    <ul class="job-results">
      {#each $controller.items as item(item.sourceId)}<li><div><strong>{itemName(item)}</strong><p class="dim">{item.status}{item.suggestions?` · ${item.suggestions} suggestions`:''}{item.error?` · ${item.error}`:''}</p></div>{#if selected.kind==='match'&&['review','unmatched','failed'].includes(item.status)}<button type="button" onclick={()=>reviewing=item}>Review</button>{/if}</li>{/each}
    </ul>
    {#if !$controller.items.length}<p>No results in this category yet.</p>{/if}
    <div class="actions"><button type="button" onclick={()=>void controller.first()}>First page</button><button type="button" disabled={!$controller.nextCursor} onclick={()=>void controller.next()}>Next results</button></div>
  {/if}
{/if}

<style>
  progress{width:100%}label{display:grid;gap:.4rem;margin:1rem 0}select{width:100%;max-width:100%}.job-results{list-style:none;padding:0}.job-results li{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.7rem 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere}.job-results li>div{min-width:0}.job-results p{margin:.3rem 0 0}details{margin:1rem 0}
</style>
