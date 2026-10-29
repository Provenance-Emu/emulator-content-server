<script lang="ts">
  import type { LibraryScope, MatchingPlugin } from '@ecs/client';
  import { onMount, tick } from 'svelte';
  import type { ServerContext } from './lib/application';
  import { canChecksum, type BulkMatchingController, type BulkMatchRow } from './lib/bulk-matching';
  import { explain } from './lib/problems';
  import MatchingProviders from './components/MatchingProviders.svelte';
  import MatchingPanel from './MatchingPanel.svelte';

  let { context, controller, scope, onchanged }: {
    context: ServerContext; controller: BulkMatchingController; scope: LibraryScope; onchanged: () => void;
  } = $props();
  let plugins = $state<MatchingPlugin[]>([]);
  let providerIds = $state<string[]>([]);
  let managerId = $state('org.ecs.matches');
  let online = $state(true);
  let failure = $state<string|null>(null);
  let ready = $state(false);
  let registryLoading = $state(false);
  let disposed = false;
  let reviewing = $state<BulkMatchRow|null>(null);
  let reviewBusy = $state(false);
  let reviewHeading = $state<HTMLHeadingElement>();
  $effect(()=>{const id=reviewing?.entry.id;if(id)void tick().then(()=>{if(!disposed&&reviewing?.entry.id===id)reviewHeading?.focus();});});
  const unresolved = $derived($controller.rows.filter(r=>r.entry.source&&['review','failed','unmatched'].includes(r.status)));
  const reviewedCount = $derived($controller.rows.filter(r=>r.status==='reviewed').length);
  let filter = $state('review');
  let page = $state(0);
  const running = $derived(['discovering','running'].includes($controller.phase));
  const activeProviders=$derived(plugins.some((plugin)=>plugin.kind==='provider'&&providerIds.includes(plugin.id)&&(!plugin.network||online)));
  const completed = $derived($controller.rows.filter((r)=>!['pending','working'].includes(r.status)).length);
  const saved = $derived($controller.rows.reduce((total,r)=>total+r.saved,0));
  const rows = $derived($controller.rows.filter((r)=>filter==='all'||(filter==='failed'?r.retryable:r.status===filter)));
  const pageRows = $derived(rows.slice(page*12,page*12+12));
  $effect(()=>{const last=Math.max(0,Math.ceil(rows.length/12)-1);if(page>last)page=last;});
  const tabs = [['review','Needs review'],['failed','Failed'],['unmatched','No match'],['skipped','Skipped'],['all','All games']] as const;
  onMount(()=>{
    void loadPlugins();
    return ()=>{disposed=true;};
  });
  async function loadPlugins(){
    if(disposed||registryLoading)return;
    registryLoading=true;failure=null;
    try {
      const registry=await context.client.matchingPlugins();
      if(disposed)return;
      plugins=registry.plugins;
      // Online cheat indexes are optional for bulk runs: anonymous GitHub API quotas are small.
      providerIds=$controller.options.providerIds??plugins.filter((p)=>p.kind==='provider'&&(!p.network||!p.capabilities.some(cap=>['cheats','patch'].includes(cap)))).map((p)=>p.id);
      online=$controller.phase==='idle'?true:$controller.options.online===true;
      managerId=$controller.options.managerId??'org.ecs.matches';ready=true;
    } catch(error){if(!disposed)failure=explain(error);}
    finally {if(!disposed)registryLoading=false;}
  }
  function review(row:BulkMatchRow){controller.pause();reviewing=row;}
  function advance(resolve:boolean){
    if(!reviewing||reviewBusy)return;
    const id=reviewing.entry.id;
    const position=$controller.rows.findIndex(r=>r.entry.id===id);
    const ordered=[...$controller.rows.slice(position+1),...$controller.rows.slice(0,position)];
    if(resolve)controller.reviewed(id);
    reviewing=ordered.find(r=>r.entry.source&&['review','failed','unmatched'].includes(r.status))??null;
    onchanged();
  }
  function done(){advance(true);}
</script>

<div class="matching-page">
{#if reviewing?.entry.source}
  <div class="matching-actions" aria-label="Review navigation"><button type="button" disabled={reviewBusy} onclick={()=>reviewing=null}>Back to matching results</button><button type="button" class="primary" disabled={reviewBusy} onclick={done}>Done reviewing this game</button>{#if unresolved.length>1}<button type="button" disabled={reviewBusy} onclick={()=>advance(false)}>Next unresolved game</button>{/if}</div>
  <p role="status" aria-live="polite">{unresolved.length} unresolved game{unresolved.length===1?'':'s'} · {reviewedCount} reviewed</p>
  <h3 tabindex="-1" bind:this={reviewHeading}>{reviewing.entry.name}</h3>
  {#if reviewing.reason}<p>{reviewing.reason}</p>{/if}
  <details class="matching-disclosure"><summary>Review tips</summary><div class="matching-disclosure-content"><p class="dim">Suggestions refresh when you open a game, so expired proposals cannot overwrite your choices. Save and next moves through unsaved categories, then the next unresolved game. Next unresolved game leaves this game in the queue.</p></div></details>
  {#key reviewing.entry.id}<MatchingPanel {context} owner={true} {onchanged} sourceId={reviewing.entry.id} sourceName={reviewing.entry.source.name} onnext={()=>{reviewBusy=false;advance(true);}} onbusy={busy=>reviewBusy=busy} reviewOptions={{...$controller.options,checksum:canChecksum(reviewing.entry.source)}} />{/key}
{:else}
  <p>Match server-folder games in this library. Unique checksum matches save automatically; conflicting matches and filename suggestions stay for review.</p>
  {#if $controller.phase==='idle'}
    <details class="matching-disclosure matching-options-disclosure"><summary>Matching options</summary><div class="matching-disclosure-content matching-fields"><MatchingProviders {plugins} bind:online bind:providerIds bind:managerId disabled={running} /><p class="dim">Checksums are verified for local ROMs up to 64 MB. Archives and disc sets use filename suggestions. Online cheats are optional. Existing saved choices stay intact. Saving metadata updates details visible to people who can read the game. Original files stay unchanged; patches and cheats are never applied automatically.</p></div></details>
    {#if ready&&!activeProviders}<p class="dim">Select a local provider or enable a selected online provider before matching.</p>{/if}
    <div class="matching-actions"><button type="button" class="primary" disabled={!ready||!activeProviders} onclick={()=>void controller.start(scope,{online,providerIds,managerId})}>Start library matching</button></div>
  {:else}
    <div class="summary matching-summary" role="status" aria-live="polite">
      <span><strong>{completed} / {$controller.rows.length}</strong> games checked</span>
      <span><strong>{saved}</strong> exact matches auto-saved</span>
      <span>{reviewedCount} games reviewed</span>
      <span><strong>{$controller.rows.filter((r)=>r.status==='review').length}</strong> games to review</span>
    </div>
    {#if running}
      <progress class="matching-progress" max={Math.max(1,$controller.rows.length)} value={completed} aria-label="Library matching progress"></progress>
      <p>{$controller.phase==='discovering'?'Collecting all library pages…':`Matching ${$controller.rows.find((r)=>r.status==='working')?.entry.name??'games'}…`}</p>
      <div class="matching-actions"><button type="button" onclick={()=>controller.pause()}>Pause matching</button></div>
    {:else if $controller.phase==='paused'}<div class="matching-actions"><button type="button" class="primary" onclick={()=>void controller.resume()}>Resume matching</button></div>
    {:else}<p role="status">Library matching complete.</p>{/if}
    {#if !running}<div class="matching-actions" aria-label="Matching run actions">
      {#if $controller.rows.some((r)=>r.retryable)}<button type="button" onclick={()=>void controller.retryFailures()}>Retry failed games</button>{/if}
      {#if $controller.rows.some((r)=>r.status==='unmatched')}<button type="button" onclick={()=>{filter='review';page=0;void controller.retryUnmatched();}}>Retry unmatched games</button>{/if}
      <button type="button" onclick={()=>controller.reset()}>New matching run</button>
    </div>{/if}
  {/if}
  <p class="dim">Keep this app open on this library while matching. You can close this panel and browse; reloading or leaving the library stops the run. Saved matches are kept.</p>
  {#if failure||$controller.failure}<p class="problem" role="alert">{failure??$controller.failure}</p>{/if}
  {#if failure}<button type="button" disabled={registryLoading} onclick={()=>void loadPlugins()}>Retry matching providers</button>{/if}
  {#if $controller.rows.length}
    <div class="actions matching-tabs" aria-label="Matching results filters">
      {#each tabs as [value,label]}<button type="button" class:active={filter===value} aria-pressed={filter===value} onclick={()=>{filter=value;page=0;}}>{label} ({value==='all'?$controller.rows.length:$controller.rows.filter((r)=>value==='failed'?r.retryable:r.status===value).length})</button>{/each}
    </div>
    {#if !rows.length}<p>No games in this category.</p>{/if}
    <ul class="matching-result-list">
      {#each pageRows as row (row.entry.entityType+':'+row.entry.id)}
        <li><div><strong>{row.entry.name}</strong><p class="dim">{row.reason||'Waiting to match'}{row.suggestions?` · ${row.suggestions} suggestions`:''}{row.saved?` · ${row.saved} auto-saved`:''}</p></div>
          {#if row.entry.source&&['review','failed','unmatched'].includes(row.status)}<button type="button" onclick={()=>review(row)}>Review</button>{/if}
        </li>
      {/each}
    </ul>
    {#if rows.length>12}<nav class="matching-actions" aria-label="Matching result pages"><button type="button" disabled={page===0} onclick={()=>page--}>Previous results</button><span>Page {page+1}</span><button type="button" disabled={(page+1)*12>=rows.length} onclick={()=>page++}>Next results</button></nav>{/if}
  {/if}
{/if}
</div>

<style>
  .summary { display:flex; flex-wrap:wrap; gap:var(--space-2); margin:var(--space-3) 0; }
  .summary span { flex:1; min-width:8rem; padding:var(--space-3); background:var(--color-surface-muted); border:1px solid var(--line); border-radius:var(--radius-control); }
  .summary strong { display:block; font-size:1.25rem; }
</style>
