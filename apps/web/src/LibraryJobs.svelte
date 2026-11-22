<script lang="ts">
  import type { MatchingPlugin, LibraryJobItem, Library, ContentRootSummary, LibraryJobScope, LibraryOverviewFolder, LibraryJob } from '@ecs/client';
  import { onMount, untrack } from 'svelte';
  import type { ServerContext } from './lib/application';
  import { createLibraryJobs } from './lib/library-jobs';
  import { shownLabel } from './lib/batches';
  import ListMore from './components/ListMore.svelte';
  import { canAttemptChecksum } from './lib/bulk-matching';
  import { explain } from './lib/problems';
  import MatchingProviders from './components/MatchingProviders.svelte';
  import MatchingPanel from './MatchingPanel.svelte';
  import LibraryCleanup from './LibraryCleanup.svelte';
  import Icon from './components/Icon.svelte';
  let cleanup=$state(false),cleanupButton:HTMLButtonElement|undefined=$state();
  let {context,scope,onchanged,libraries=[],roots=[],folders=[],initialJobId}:{context:ServerContext;scope:LibraryJobScope;onchanged:()=>void;libraries?:Library[];roots?:ContentRootSummary[];folders?:LibraryOverviewFolder[];initialJobId?:string}=$props();
  // Cleanup proposals belong to one library; the all-libraries view leaves them out.
  const cleanupScope=$derived(scope.libraryId?{libraryId:scope.libraryId}:scope.unassigned?{unassigned:true as const}:null);
  const rootLabel=(id:string)=>roots.find(row=>row.root.id===id)?.root.label??folders.find(folder=>folder.rootId===id)?.label;
  const kindText=(job:LibraryJob)=>job.kind==='scan'?'Folder scan':'Details and covers';
  /** Today is a time; anything earlier is a date. */
  const when=(iso:string)=>{const at=new Date(iso);return Number.isNaN(at.getTime())?'':at.toDateString()===new Date().toDateString()?at.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):at.toLocaleDateString([], {month:'short',day:'numeric'});};
  // Each count is also the filter for the list below it, so there is one control instead of two.
  const RESULTS=[['review','need review','need review'],['unmatched','unmatched','unmatched'],['failed','failed','failed'],['saved','saved','saved'],['skipped','skipped','skipped']] as const;
  const resultText:Record<string,string>={review:'Needs review',unmatched:'No match found',failed:'Could not be checked',saved:'Saved',skipped:'Skipped',reviewed:'Reviewed',pending:'Waiting',running:'Working'};
  function itemStatus(item:LibraryJobItem){return [resultText[item.status]??item.status,item.suggestions?`${item.suggestions} ${item.suggestions===1?'suggestion':'suggestions'}`:'',item.error??''].filter(Boolean).join(' · ');}
  async function show(next:string){filter=next;await controller.filter(next);}
  const stateText:Record<LibraryJob['state'],string>={queued:'Waiting',running:'Working',completed:'Finished',failed:'Stopped with a problem',cancelled:'Cancelled',interrupted:'Paused'};
  // Open on what needs attention; a clean job shows everything instead of an empty review list.
  const startFilter=(job:LibraryJob|undefined)=>!job?'review':job.review?'review':job.failed?'failed':job.unmatched?'unmatched':'';
  const controller=untrack(()=>createLibraryJobs(context.client,scope,{changed:onchanged,initialJobId}));
  let plugins=$state<MatchingPlugin[]>([]),providerIds=$state<string[]>([]),online=$state(true),allowExactNames=$state(true),managerId=$state('org.ecs.matches');
  let registryFailure=$state<string|null>(null),ready=$state(false),reviewing=$state<LibraryJobItem|null>(null);
  let filter=$state('review');
  let reviewBusy=$state(false);
  const selected=$derived($controller.jobs.find(job=>job.id===$controller.selectedId));
  const active=$derived(selected&&['queued','running'].includes(selected.state));
  const canMatch=$derived(ready&&plugins.some(p=>p.kind==='provider'&&providerIds.includes(p.id)&&(!p.network||online)));
  function scopeName(selected:LibraryJobScope){
    if(selected.rootId)return rootLabel(selected.rootId)??'Saved folder';
    if(selected.libraryId)return libraries.find(library=>library.id===selected.libraryId)?.name??'Library';
    return selected.unassigned?'Unassigned folders':'All libraries';
  }
  function itemName(item:LibraryJobItem){return item.source?.name??rootLabel(item.sourceId)??'Unavailable source';}
  let live=false,registryLoading=$state(false);
  onMount(()=>{live=true;controller.connect();void loadProviders();return()=>{live=false;controller.dispose();};});
  async function loadProviders(){
    if(!live||registryLoading)return;
    registryLoading=true;registryFailure=null;
    try {
      const result=await context.client.matchingPlugins();if(!live)return;
      plugins=result.plugins;providerIds=plugins.filter(p=>p.kind==='provider').map(p=>p.id);ready=true;
    }catch(error){if(live){registryFailure=explain(error);ready=false;}}
    finally{if(live)registryLoading=false;}
  }
  async function choose(id:string){reviewing=null;filter=startFilter($controller.jobs.find(job=>job.id===id));await controller.choose(id);await controller.filter(filter);}
  let opened='';
  $effect(()=>{const job=selected;if(job&&job.id!==opened&&!['queued','running'].includes(job.state)){opened=job.id;const next=startFilter(job);if(next!==untrack(()=>filter)){filter=next;void controller.filter(next);}}});
  async function start(kind:'scan'|'match',refreshCatalogs=false){reviewing=null;await controller.start(kind,kind==='match'?{online,...(providerIds.length===plugins.filter(p=>p.kind==='provider').length?{}:{providerIds}),...(managerId==='org.ecs.matches'?{}:{managerId}),checksum:true,allowExactNames,...(refreshCatalogs?{refreshCatalogs:true}:{})}:{});await controller.filter(filter);}
  async function nextReview(done:boolean) {
    if(!reviewing||reviewBusy)return;
    reviewBusy=true;
    try {
      const id=reviewing.sourceId;
      // The next unresolved game is one below this one, not the first in the list again.
      const rows=$controller.items;
      const passed=new Set(rows.slice(0,rows.findIndex(item=>item.sourceId===id)+1).map(item=>item.sourceId));
      const below=()=>$controller.items.find(item=>item.sourceId!==id&&!passed.has(item.sourceId)&&['review','unmatched','failed'].includes(item.status));
      let next=below();
      if(done){await controller.reviewed(id);if($controller.failure)return;}
      if(!next&&$controller.nextCursor){await controller.more();next=below();}
      reviewing=next??null;
    }finally{reviewBusy=false;}
  }
</script>

{#if cleanup&&cleanupScope}
<LibraryCleanup {context} scope={cleanupScope} {onchanged} onclose={()=>{cleanup=false;queueMicrotask(()=>cleanupButton?.focus());}} />
{:else if reviewing&&selected?.kind==='match'}
<!-- One game at a time: the overview steps aside so the choices are the whole screen. -->
<div class="matching-page activity-review">
  <div class="review-top">
    <button type="button" disabled={reviewBusy} onclick={()=>reviewing=null}><Icon name="back" /> Back to job results</button>
    <span class="dim">{selected.review.toLocaleString()} left to review</span>
  </div>
  <h3>{itemName(reviewing)}</h3>
  {#if $controller.failure}<p role="alert" class="problem">{$controller.failure}</p>{/if}
  {#key reviewing.sourceId}<MatchingPanel {context} owner={true} compact {onchanged} sourceId={reviewing.sourceId} sourceName={itemName(reviewing)} reviewOptions={{...selected.options,checksum:reviewing.source?canAttemptChecksum(reviewing.source):false}} onnext={()=>void nextReview(true)} />{/key}
  <div class="review-bottom" aria-label="Review navigation">
    <button type="button" disabled={reviewBusy} onclick={()=>void nextReview(false)}>Next unresolved game</button>
    <button type="button" class="primary" disabled={reviewBusy} onclick={()=>void nextReview(true)}>Done reviewing this game</button>
  </div>
</div>
{:else}
<div class="matching-page">
<p class="dim">Both of these run on the server, so you can close this and come back.</p>
<div class="matching-primary-actions" aria-label="Start library work">
  <button type="button" class="primary" disabled={$controller.loading||!canMatch} onclick={()=>void start('match')}>Find missing artwork and details</button>
  <button type="button" disabled={$controller.loading} onclick={()=>void start('scan')}>Check folder files</button>
</div>
<details class="matching-disclosure matching-secondary-actions"><summary>More library actions</summary><div class="matching-disclosure-content matching-actions">
  <button type="button" disabled={$controller.loading||!canMatch||!online} onclick={()=>void start('match',true)}>Update catalogs and find matches</button>
  <button type="button" disabled={$controller.loading} onclick={()=>void controller.refresh()}>Refresh activity</button>
</div></details>
{#if registryFailure||$controller.failure}<p role="alert" class="problem">{registryFailure??$controller.failure}</p>{/if}
{#if registryFailure}<button type="button" disabled={registryLoading} onclick={()=>void loadProviders()}>Retry matching providers</button>{/if}
{#if $controller.jobs.length}
  <label class="matching-field">Server activity<select value={$controller.selectedId??''} onchange={event=>void choose(event.currentTarget.value)}>
    {#each $controller.jobs as job(job.id)}<option value={job.id}>{scopeName(job.scope)} · {kindText(job)} · {stateText[job.state]} · {when(job.createdAt)}</option>{/each}
  </select></label>
  {#if $controller.nextJobsCursor}<button type="button" class="matching-quiet-action" disabled={$controller.loading} onclick={()=>void controller.older()}>Load older activity</button>{/if}
{:else}<p>Nothing has run yet. Start with one of the buttons above.</p>{/if}

{#if selected}
  <section aria-label="Library job progress" class="activity-card">
    {#if selected.options.refreshCatalogs&&selected.state==='running'&&selected.processed===0&&!selected.currentSourceId}<p class="dim">Preparing verified hosted catalogs…</p>{/if}
    <div class="matching-progress-heading"><strong role="status">{stateText[selected.state]}</strong><span>{selected.processed.toLocaleString()} of {selected.total.toLocaleString()} checked</span></div>
    <progress class="matching-progress" max={Math.max(1,selected.total)} value={selected.processed} aria-label="Library job progress"></progress>
    <div class="result-filter" role="group" aria-label="Job results">
      {#each RESULTS as [id,label,one]}
        {#if selected.kind==='match'||selected[id]>0||filter===id}<button type="button" class:active={filter===id} aria-pressed={filter===id} onclick={()=>void show(id)}><strong>{selected[id].toLocaleString()}</strong> {selected[id]===1?one:label}</button>{/if}
      {/each}
      <button type="button" class:active={filter===''} aria-pressed={filter===''} onclick={()=>void show('')}>All</button>
    </div>
    {#if selected.error}<p class="problem">{selected.error}</p>{/if}
    {#if selected.providerFailures}<p class="problem">An online source could not be reached for {selected.providerFailures.toLocaleString()} {selected.providerFailures===1?'game':'games'}, so results may be incomplete. Check the server's internet connection, then retry.</p>{/if}
    <div class="matching-actions">
      {#if active}<button type="button" disabled={$controller.loading} onclick={()=>void controller.cancel(selected.id)}>Cancel job</button>
      {:else if ['cancelled','interrupted','failed'].includes(selected.state)}<button type="button" disabled={$controller.loading} onclick={()=>void controller.resume(selected.id)}>Resume remaining work</button>{/if}
      {#if !active&&selected.failed}<button type="button" disabled={$controller.loading} onclick={()=>void controller.resume(selected.id,'failed')}>Retry failed games</button>{/if}
      {#if !active&&selected.unmatched}<button type="button" disabled={$controller.loading} onclick={()=>void controller.resume(selected.id,'unmatched')}>Retry unmatched games</button>{/if}
    </div>
    <ul class="matching-result-list">
      {#each $controller.items as item(item.sourceId)}<li><div><strong>{itemName(item)}</strong><p class="dim">{itemStatus(item)}</p></div>{#if selected.kind==='match'&&(['review','unmatched','failed'].includes(item.status)||item.suggestions>0)}<button type="button" onclick={()=>reviewing=item}>Review</button>{/if}</li>{/each}
    </ul>
    {#if !$controller.items.length}<p class="dim">{filter?`Nothing ${resultText[filter]?.toLowerCase()??'here'} in this run.`:active?'Results appear here as games are checked.':'This run has no results.'}</p>{/if}
    {#if $controller.items.length}<ListMore label={shownLabel($controller.items.length,!!$controller.nextCursor,['result','results'])} more={!!$controller.nextCursor} busy={$controller.loadingMore} failed={!!$controller.failure} action="Show more results" onmore={()=>void controller.more()} />{/if}
    {#if selected.kind==='match'}<p class="dim activity-note">{selected.options.allowExactNames?'This run also saved exact file-name matches on its own.':'This job uses verified ROM or disc IDs for automatic selections.'}</p>{/if}
  </section>
{/if}
<details class="matching-disclosure matching-options-disclosure">
  <summary>Matching options</summary>
  <div class="matching-disclosure-content matching-fields">
    <label class="matching-check"><input type="checkbox" bind:checked={allowExactNames} disabled={$controller.loading} /> For new jobs, use exact filenames when a game ID is unavailable</label>
    <p class="form-help">Only a full title and edition match is saved this way. Anything that disagrees waits for you.</p>
    <MatchingProviders {plugins} bind:online bind:providerIds bind:managerId disabled={$controller.loading} />
    <p class="dim">A match that is certain is saved on its own; anything doubtful waits for review. Cheats are saved switched off, and patches are never applied for you.</p>
  </div>
</details>
  {#if cleanupScope}<div class="matching-actions"><button type="button" bind:this={cleanupButton} onclick={()=>cleanup=true}>Review library cleanup</button></div>{/if}
</div>
{/if}

<style>
  .activity-card { display: grid; gap: var(--space-3); margin-top: 0; }
  .activity-card > p { margin: 0; }
  .activity-note { font-size: var(--text-small); }
  .matching-result-list button { flex: none; white-space: nowrap; }
  .result-filter { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .result-filter button { min-height: 2.25rem; padding: 0 var(--space-3); border-radius: 999px; font-size: var(--text-small); }
  .result-filter button.active { background: var(--color-selected); border-color: var(--color-selected-border); color: var(--color-selected-text); }
  .review-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .activity-review h3 { margin: 0; overflow-wrap: anywhere; }
  .review-bottom {
    position: sticky;
    bottom: 0;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) 0;
    border-top: var(--border-width) solid var(--color-border);
    background: var(--color-surface);
  }
</style>
