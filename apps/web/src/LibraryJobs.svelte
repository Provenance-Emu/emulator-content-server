<script lang="ts">
  import type { LibraryScope, MatchingPlugin, LibraryJobItem, Library, ContentRootSummary, LibraryJobScope } from '@ecs/client';
  import { onMount, untrack } from 'svelte';
  import type { ServerContext } from './lib/application';
  import { createLibraryJobs } from './lib/library-jobs';
  import { canAttemptChecksum } from './lib/bulk-matching';
  import { explain } from './lib/problems';
  import MatchingProviders from './components/MatchingProviders.svelte';
  import MatchingPanel from './MatchingPanel.svelte';
  let {context,scope,onchanged,libraries=[],roots=[]}:{context:ServerContext;scope:LibraryScope;onchanged:()=>void;libraries?:Library[];roots?:ContentRootSummary[]}=$props();
  const controller=untrack(()=>createLibraryJobs(context.client,scope,{changed:onchanged}));
  let plugins=$state<MatchingPlugin[]>([]),providerIds=$state<string[]>([]),online=$state(true),allowExactNames=$state(true),managerId=$state('org.ecs.matches');
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
      plugins=result.plugins;providerIds=plugins.filter(p=>p.kind==='provider'&&(!p.network||!p.capabilities.some(cap=>['cheats','patch'].includes(cap)))).map(p=>p.id);ready=true;
    }catch(error){if(live){registryFailure=explain(error);ready=false;}}
    finally{if(live)registryLoading=false;}
  }
  async function choose(id:string){reviewing=null;await controller.choose(id);await controller.filter(filter);}
  async function start(kind:'scan'|'match',refreshCatalogs=false){reviewing=null;await controller.start(kind,kind==='match'?{online,providerIds,managerId,checksum:true,allowExactNames,...(refreshCatalogs?{refreshCatalogs:true}:{})}:{});await controller.filter(filter);}
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

<div class="matching-page">
<p class="dim">Library work runs on the server and is shared across sessions. You can return while a job is running.</p>
<div class="matching-primary-actions" aria-label="Start library work">
  <button type="button" class="primary" disabled={$controller.loading||!canMatch} onclick={()=>void start('match')}>Find missing artwork and details</button>
  <button type="button" disabled={$controller.loading} onclick={()=>void start('scan')}>Scan saved folders</button>
</div>
<details class="matching-disclosure matching-secondary-actions"><summary>More library actions</summary><div class="matching-disclosure-content matching-actions">
  <button type="button" disabled={$controller.loading||!canMatch||!online} onclick={()=>void start('match',true)}>Update catalogs and find matches</button>
  <button type="button" disabled={$controller.loading} onclick={()=>void controller.refresh()}>Refresh activity</button>
</div></details>
{#if $controller.jobs.length}
  <label class="matching-field">Server activity<select value={$controller.selectedId??''} onchange={event=>void choose(event.currentTarget.value)}>
    {#each $controller.jobs as job(job.id)}<option value={job.id}>{scopeName(job.scope)} · {job.kind==='scan'?'Folder scan':'Artwork and metadata'} · {job.state} · {job.processed}/{job.total} · {new Date(job.createdAt).toLocaleString()}</option>{/each}
  </select></label>
  {#if $controller.nextJobsCursor}<button type="button" class="matching-quiet-action" disabled={$controller.loading} onclick={()=>void controller.older()}>Load older activity</button>{/if}
{:else}<p>No library jobs yet.</p>{/if}
{#if registryFailure||$controller.failure}<p role="alert" class="problem">{registryFailure??$controller.failure}</p>{/if}
{#if registryFailure}<button type="button" disabled={registryLoading} onclick={()=>void loadProviders()}>Retry matching providers</button>{/if}

{#if selected}
  <section aria-label="Library job progress">
    {#if selected.kind==='match'}<p class="dim">{selected.options.allowExactNames?'Exact filename fallback was enabled for this job.':'This job uses verified ROM or disc IDs for automatic selections.'}</p>{/if}
    {#if selected.options.refreshCatalogs&&selected.state==='running'&&selected.processed===0&&!selected.currentSourceId}<p role="status">Preparing verified hosted catalogs…</p>{/if}
    <div class="matching-progress-heading"><strong role="status">{selected.state}</strong><span>{selected.processed.toLocaleString()} of {selected.total.toLocaleString()} checked</span></div>
    <progress class="matching-progress" max={Math.max(1,selected.total)} value={selected.processed} aria-label="Library job progress"></progress>
    <div class="matching-stat-row" aria-label="Job results">
      <span>{selected.saved.toLocaleString()} saved</span><span>{selected.review.toLocaleString()} need review</span><span>{selected.unmatched.toLocaleString()} unmatched</span><span>{selected.failed.toLocaleString()} failed</span><span>{selected.skipped.toLocaleString()} skipped</span>
    </div>
    {#if selected.error}<p class="problem">{selected.error}</p>{/if}
    <div class="matching-actions">
      {#if active}<button type="button" disabled={$controller.loading} onclick={()=>void controller.cancel(selected.id)}>Cancel job</button>
      {:else if ['cancelled','interrupted','failed'].includes(selected.state)}<button type="button" disabled={$controller.loading} onclick={()=>void controller.resume(selected.id)}>Resume remaining work</button>{/if}
      {#if !active&&selected.failed}<button type="button" disabled={$controller.loading} onclick={()=>void controller.resume(selected.id,'failed')}>Retry failed games</button>{/if}
      {#if !active&&selected.unmatched}<button type="button" disabled={$controller.loading} onclick={()=>void controller.resume(selected.id,'unmatched')}>Retry unmatched games</button>{/if}
    </div>
  </section>
{/if}
{#if !reviewing}
<details class="matching-disclosure matching-options-disclosure">
  <summary>Matching options</summary>
  <div class="matching-disclosure-content matching-fields">
    <label class="matching-check"><input type="checkbox" bind:checked={allowExactNames} disabled={$controller.loading} /> For new jobs, use exact filenames when a game ID is unavailable</label>
    <p class="form-help">Only a full title and edition match can use this fallback. Conflicting IDs, checksums, and editions stay in review.</p>
    <MatchingProviders {plugins} bind:online bind:providerIds bind:managerId disabled={$controller.loading} />
    <p class="dim">Catalog updates download verified metadata and cheat or patch indexes for systems in this library. Cheat and patch files download only when selected; cheats stay disabled and patches are never applied automatically. Verified ROM or disc-ID matches can save automatically. Other suggestions and conflicting evidence need review. Unavailable files are skipped.</p>
  </div>
</details>
{/if}
{#if selected}
  {#if reviewing&&selected.kind==='match'}
    <div class="matching-actions" aria-label="Review navigation"><button type="button" disabled={reviewBusy} onclick={()=>reviewing=null}>Back to job results</button><button type="button" class="primary" disabled={reviewBusy} onclick={()=>void nextReview(true)}>Done reviewing this game</button><button type="button" disabled={reviewBusy} onclick={()=>void nextReview(false)}>Next unresolved game</button></div>
    <h3>{itemName(reviewing)}</h3>
    {#key reviewing.sourceId}<MatchingPanel {context} owner={true} {onchanged} sourceId={reviewing.sourceId} sourceName={itemName(reviewing)} reviewOptions={{...selected.options,checksum:reviewing.source?canAttemptChecksum(reviewing.source):false}} onnext={()=>void nextReview(true)} />{/key}
  {:else}
    <label class="matching-field">Results<select bind:value={filter} onchange={()=>void controller.filter(filter)}><option value="review">Needs review</option><option value="failed">Failed</option><option value="unmatched">No match</option><option value="saved">Saved</option><option value="skipped">Skipped</option><option value="">All results</option></select></label>
    <ul class="matching-result-list">
      {#each $controller.items as item(item.sourceId)}<li><div><strong>{itemName(item)}</strong><p class="dim">{item.status}{item.suggestions?` · ${item.suggestions} suggestions`:''}{item.error?` · ${item.error}`:''}</p></div>{#if selected.kind==='match'&&(['review','unmatched','failed'].includes(item.status)||item.suggestions>0)}<button type="button" onclick={()=>reviewing=item}>Review</button>{/if}</li>{/each}
    </ul>
    {#if !$controller.items.length}<p>No results in this category yet.</p>{/if}
    <div class="matching-actions"><button type="button" onclick={()=>void controller.first()}>First page</button><button type="button" disabled={!$controller.nextCursor} onclick={()=>void controller.next()}>Next results</button></div>
  {/if}
{/if}
</div>

<style>
  section[aria-label="Library job progress"] { margin-top: 0; }
  section[aria-label="Library job progress"] > p:first-of-type { margin-top: 0; }
  section[aria-label="Library job progress"] > p:last-of-type { margin-bottom: 0; }
</style>
