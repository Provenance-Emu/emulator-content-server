<script lang="ts">
 import type {LibraryScope,WorkflowProposal,WorkflowApplication} from '@ecs/client';
 import {onMount,untrack} from 'svelte';
 import type {ServerContext} from './lib/application';
 import {createWorkflowRuns} from './lib/workflow-runs';
 import CleanupProposal from './CleanupProposal.svelte';
 import Icon from './components/Icon.svelte';
 import ListMore from './components/ListMore.svelte';
 import {shownLabel} from './lib/batches';
 import {findingLabel} from './lib/cleanup-labels';
 let {context,scope,onchanged,onclose}:{context:ServerContext;scope:LibraryScope;onchanged:()=>void;onclose?:()=>void}=$props();
 const controller=untrack(()=>createWorkflowRuns(context.client,scope,{changed:onchanged}));
 let heading:HTMLHeadingElement|undefined=$state(),hostId=$state(''),online=$state(false);
 const hosts=$derived($controller.hosts.filter(h=>h.enrolled&&!h.revokedAt&&h.packages?.some(p=>p.id==='org.ecs.library-cleanup'&&p.kind==='workflow')));
 const host=$derived(hosts.find(h=>h.id===hostId)??hosts[0]);
 const workflow=$derived(host?.packages?.find(p=>p.id==='org.ecs.library-cleanup'&&p.kind==='workflow'));
 const loneFindings=$derived($controller.findings.filter(f=>!$controller.proposals.some(p=>p.findingId===f.id)));
 // The lists refresh on a timer; only the one that was asked for more says it is loading.
 let asking=$state<'Proposals'|'Findings'|'Applications'|null>(null);
 async function more(which:'Proposals'|'Findings'|'Applications'){asking=which;try{await controller[`more${which}`]();}finally{asking=null;}}
 const active=$derived($controller.run&&['queued','running'].includes($controller.run.state));
 $effect(()=>{const next=scope;void controller.setScope(next).then(()=>controller.refresh())});
 onMount(()=>{if(onclose)heading?.focus();controller.connect();return()=>controller.dispose()});
 const STATE:Record<string,string>={queued:'Waiting',running:'Checking',completed:'Finished',interrupted:'Paused',cancelled:'Cancelled',failed:'Stopped with a problem','recovery-required':'Needs attention'};
 const stateText=(value:string)=>STATE[value]??value;
 const RECEIPT:Record<string,string>={applied:'Saved',undone:'Undone',skipped:'Skipped'};
 const gameName=(sourceId:string)=>$controller.proposals.find(p=>p.sourceId===sourceId)?.sourceName??'A game';
 const unresolved=$derived($controller.results.filter(row=>{try{return !!JSON.parse(row.outputJson??'{}').unresolved}catch{return true}}).length);
 function application(p:WorkflowProposal):WorkflowApplication|undefined{return $controller.applications.find(a=>{try{return JSON.parse(a.resultJson).proposals?.some((r:{id:string;version:number;digest:string})=>r.id===p.id&&r.version===p.version&&r.digest===p.digest)}catch{return false}})}
 async function start(){if(!host||!workflow)return;await controller.start({hostId:host.id,workflowId:workflow.id,workflowDigest:workflow.digest,scope,options:{online,checksum:true,shareImages:false}})}
</script>
<section class="matching-page cleanup-page" aria-label="Library cleanup review">
 {#if onclose}
  <div class="matching-progress-heading"><h2 bind:this={heading} tabindex="-1">Library cleanup</h2><button type="button" onclick={onclose}>Close cleanup review</button></div>
 {/if}
 <p>Looks for games whose details or cover look wrong and suggests a fix for each. Nothing changes until you approve the fixes and apply them.</p>
 {#if hosts.length>1}<label class="matching-field">Workflow host<select bind:value={hostId}>{#each hosts as row}<option value={row.id}>{row.name}</option>{/each}</select></label>
 {:else if !hosts.length}
  <div class="cleanup-setup">
   <p><strong>Cleanup is not set up yet.</strong> It runs in a helper beside the server.</p>
   <details><summary>How to set it up</summary><p>In Terminal on the server, run <code>ecs-plugins workflows install-defaults</code>, then connect the helper in Settings.</p></details>
  </div>
 {/if}
 <label class="matching-check"><input type="checkbox" bind:checked={online} disabled={$controller.loading||!!active} /> Search online catalogs</label>
 <p class="dim cleanup-small">Checks on this server need no account, and pictures are never sent anywhere.</p>
 <div class="matching-actions">
  <button type="button" class="primary" disabled={$controller.loading||!workflow||!!active} onclick={()=>void start()}>Start cleanup inspection</button>
  <button type="button" class="icon-only" aria-label="Refresh cleanup" title="Refresh" disabled={$controller.loading} onclick={()=>void controller.refresh()}><Icon name="refresh" /></button>
 </div>
 {#if $controller.failure}<p role="alert" class="problem">{$controller.failure}</p>{/if}
 {#if $controller.notice}<p role="status">{$controller.notice}</p>{/if}
 {#if $controller.runs.length}<label class="matching-field">Cleanup activity<select value={$controller.run?.id??''} disabled={$controller.loading} onchange={event=>void controller.choose(event.currentTarget.value)}>{#each $controller.runs as run}<option value={run.id}>{new Date(run.createdAt).toLocaleString([], {dateStyle:'medium',timeStyle:'short'})} · {stateText(run.state)} · {run.processed} of {run.total}{run.workflowId==='org.ecs.investigator-cleanup'?' · by an assistant':''}</option>{/each}</select></label>{/if}
 {#if $controller.nextRunsCursor}<button type="button" class="matching-quiet-action" disabled={$controller.loading} onclick={()=>void controller.moreRuns()}>Show older cleanup runs</button>{/if}
 {#if $controller.run}
  <div class="cleanup-run">
   <p data-testid="cleanup-progress" role="status"><strong>{stateText($controller.run.state)}</strong> · {$controller.run.processed.toLocaleString()} of {$controller.run.total.toLocaleString()} games checked</p>
   <progress class="matching-progress" max={Math.max(1,$controller.run.total)} value={$controller.run.processed} aria-label="Cleanup progress"></progress>
  </div>
  {#if $controller.run.error}<p class="problem">{$controller.run.error}</p>{/if}
  <div class="matching-actions">{#if active}<button type="button" disabled={$controller.loading} onclick={()=>void controller.cancel()}>Cancel inspection</button>{:else if $controller.run.workflowId!=='org.ecs.investigator-cleanup'&&['interrupted','cancelled'].includes($controller.run.state)}<button type="button" disabled={$controller.loading} onclick={()=>void controller.resume()}>Resume inspection</button>{/if}</div>
  {#if $controller.run.state==='recovery-required'}<p>This run cannot be continued safely. Start a new inspection.</p>{/if}
  {#if $controller.proposals.length}
   <div class="cleanup-approval">
    <strong>{$controller.selected.length} selected</strong>
    <button type="button" disabled={$controller.loading||!$controller.selected.length} onclick={()=>void controller.approve()}>Approve {$controller.selected.length} selected {$controller.selected.length===1?'fix':'fixes'}</button>
    {#if $controller.approval}<button type="button" class="primary" disabled={$controller.loading} onclick={()=>void controller.apply()}>Apply approved fixes</button>{/if}
   </div>
  {/if}
  {#each $controller.proposals as proposal(proposal.id+':'+proposal.version)}<CleanupProposal {context} {proposal} finding={$controller.findings.find(f=>f.id===proposal.findingId)} current={$controller.selections[proposal.sourceId]} selected={$controller.selected.some(p=>p.id===proposal.id)} busy={$controller.loading} application={application(proposal)} onselect={checked=>controller.select(proposal,checked)} ondecide={decision=>void controller.decide(proposal.findingId,decision)} />{/each}
  {#if $controller.nextProposalsCursor}<ListMore label={shownLabel($controller.proposals.length,true,['fix','fixes'])} more busy={$controller.loading} reading={asking==='Proposals'} failed={!!$controller.failure} action="Show more fixes" onmore={()=>void more('Proposals')} />{/if}
  {#each loneFindings as finding(finding.id)}<article class="cleanup-finding"><strong>{findingLabel(finding.kind)}</strong><p>{finding.reason}</p>{#if finding.dismissed}<p class="dim">Reviewed</p>{:else}<div class="matching-actions"><button type="button" disabled={$controller.loading} onclick={()=>void controller.decide(finding.id,'keep')}>Keep current</button><button type="button" disabled={$controller.loading} onclick={()=>void controller.decide(finding.id,'dismiss')}>Dismiss finding</button></div>{/if}</article>{/each}
  {#if $controller.nextFindingsCursor}<ListMore label={shownLabel(loneFindings.length,true,['finding','findings'])} more busy={$controller.loading} reading={asking==='Findings'} failed={!!$controller.failure} action="Show more findings" onmore={()=>void more('Findings')} />{/if}
  {#if !$controller.proposals.length&&!$controller.findings.length}<p class="dim">{$controller.run.state==='completed'?'Nothing needs fixing.':'Suggestions appear here as games are checked.'}</p>{/if}
  {#if unresolved}<p class="dim">{unresolved.toLocaleString()} {unresolved===1?'game':'games'} could not be checked: a catalog was unavailable, or the file could not be identified.</p>{/if}
  {#if $controller.applications.length}<h3>Saved fixes</h3>{#each $controller.applications as receipt(receipt.id+receipt.sourceId)}<div class="cleanup-receipt"><span>{gameName(receipt.sourceId)} · {RECEIPT[receipt.status]??receipt.status}</span>{#if receipt.status==='applied'&&Date.parse(receipt.undoExpiresAt)>Date.now()}<button type="button" disabled={$controller.loading} onclick={()=>void controller.undo(receipt)}>Undo saved fixes</button>{/if}</div>{/each}{/if}
  {#if $controller.nextApplicationsCursor}<ListMore label={shownLabel($controller.applications.length,true,['saved fix','saved fixes'])} more busy={$controller.loading} reading={asking==='Applications'} failed={!!$controller.failure} action="Show older saved batches" onmore={()=>void more('Applications')} />{/if}
 {/if}
</section>
<style>
 .cleanup-page{min-width:0}
 .cleanup-small{margin:0;font-size:var(--text-small)}
 .cleanup-setup{padding:var(--space-3) var(--space-4);border:var(--border-width) dashed var(--color-border-strong);border-radius:var(--radius-panel)}
 .cleanup-setup p{margin:0 0 var(--space-2)}
 .cleanup-run{display:grid;gap:var(--space-2)}
 .cleanup-run p{margin:0}
 .cleanup-approval{position:sticky;top:0;z-index:1;display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap;padding:var(--space-3) 0;background:var(--color-surface);border-bottom:var(--border-width) solid var(--color-border)}
 .cleanup-receipt{display:flex;gap:var(--space-4);justify-content:space-between;align-items:center;flex-wrap:wrap;overflow-wrap:anywhere;margin-block:var(--space-3)}
 .cleanup-finding{padding:var(--space-4) 0;border-bottom:var(--border-width) solid var(--color-border)}
 .cleanup-finding p{margin:var(--space-1) 0 var(--space-2)}
 h2{outline:none}
</style>
