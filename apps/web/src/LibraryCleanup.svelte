<script lang="ts">
 import type {LibraryScope,WorkflowProposal,WorkflowApplication} from '@ecs/client';
 import {onMount,untrack} from 'svelte';
 import type {ServerContext} from './lib/application';
 import {createWorkflowRuns} from './lib/workflow-runs';
 import CleanupProposal from './CleanupProposal.svelte';
 let {context,scope,onchanged,onclose}:{context:ServerContext;scope:LibraryScope;onchanged:()=>void;onclose:()=>void}=$props();
 const controller=untrack(()=>createWorkflowRuns(context.client,scope,{changed:onchanged}));
 let heading:HTMLHeadingElement|undefined=$state(),hostId=$state(''),online=$state(false);
 const hosts=$derived($controller.hosts.filter(h=>h.enrolled&&!h.revokedAt&&h.packages?.some(p=>p.id==='org.ecs.library-cleanup'&&p.kind==='workflow')));
 const host=$derived(hosts.find(h=>h.id===hostId)??hosts[0]);
 const workflow=$derived(host?.packages?.find(p=>p.id==='org.ecs.library-cleanup'&&p.kind==='workflow'));
 const active=$derived($controller.run&&['queued','running'].includes($controller.run.state));
 $effect(()=>{const next=scope;void controller.setScope(next).then(()=>controller.refresh())});
 onMount(()=>{heading?.focus();controller.connect();return()=>controller.dispose()});
 function application(p:WorkflowProposal):WorkflowApplication|undefined{return $controller.applications.find(a=>{try{return JSON.parse(a.resultJson).proposals?.some((r:{id:string;version:number;digest:string})=>r.id===p.id&&r.version===p.version&&r.digest===p.digest)}catch{return false}})}
 async function start(){if(!host||!workflow)return;await controller.start({hostId:host.id,workflowId:workflow.id,workflowDigest:workflow.digest,scope,options:{online,checksum:true,shareImages:false}})}
</script>
<section class="matching-page cleanup-page" aria-label="Library cleanup review">
 <div class="matching-progress-heading"><h2 bind:this={heading} tabindex="-1">Library cleanup</h2><button type="button" onclick={onclose}>Close cleanup review</button></div>
 <p>Find questionable matches and missing front covers. Inspection creates suggestions. Only the fixes you approve and apply will be saved.</p>
 {#if hosts.length}<label class="matching-field">Workflow host<select bind:value={hostId}>{#each hosts as row}<option value={row.id}>{row.name}</option>{/each}</select></label>{:else}<p>No connected cleanup host. Install the default workflow with <code>ecs-plugins workflows install-defaults</code> and connect its host in settings.</p>{/if}
 <label class="matching-field"><span><input type="checkbox" bind:checked={online} disabled={$controller.loading||!!active} /> Search online catalogs</span></label>
 <p class="dim">Local catalogs and sidecars work without an AI key. Images are not shared with a model.</p>
 <div class="matching-actions"><button type="button" class="primary" disabled={$controller.loading||!workflow||!!active} onclick={()=>void start()}>Start cleanup inspection</button><button type="button" disabled={$controller.loading} onclick={()=>void controller.refresh()}>Refresh cleanup</button></div>
 {#if $controller.failure}<p role="alert" class="problem">{$controller.failure}</p>{/if}
 {#if $controller.notice}<p role="status">{$controller.notice}</p>{/if}
 {#if $controller.runs.length}<label class="matching-field">Cleanup activity<select value={$controller.run?.id??''} disabled={$controller.loading} onchange={event=>void controller.choose(event.currentTarget.value)}>{#each $controller.runs as run}<option value={run.id}>{new Date(run.createdAt).toLocaleString()} · {run.state} · {run.processed}/{run.total}</option>{/each}</select></label>{/if}
 {#if $controller.nextRunsCursor}<button type="button" disabled={$controller.loading} onclick={()=>void controller.nextRuns()}>Older cleanup runs</button>{/if}
 {#if $controller.run}
  <p data-testid="cleanup-progress" role="status">Inspection {$controller.run.state} · {$controller.run.processed} of {$controller.run.total} checked. Saving fixes is a separate step.</p>
  {#if $controller.run.error}<p class="problem">{$controller.run.error}</p>{/if}
  <div class="matching-actions">{#if active}<button type="button" disabled={$controller.loading} onclick={()=>void controller.cancel()}>Cancel inspection</button>{:else if ['interrupted','cancelled'].includes($controller.run.state)}<button type="button" disabled={$controller.loading} onclick={()=>void controller.resume()}>Resume inspection</button>{/if}</div>
  {#if $controller.run.state==='recovery-required'}<p>Private host state could not be recovered safely. Restore the matching host backup or start a fresh inspection.</p>{/if}
  <div class="cleanup-approval"><strong>{$controller.selected.length} selected</strong> <button type="button" disabled={$controller.loading||!$controller.selected.length} onclick={()=>void controller.approve()}>Approve {$controller.selected.length} selected {$controller.selected.length===1?'fix':'fixes'}</button>{#if $controller.approval}<button type="button" class="primary" disabled={$controller.loading} onclick={()=>void controller.apply()}>Apply approved fixes</button>{/if}</div>
  {#each $controller.proposals as proposal(proposal.id+':'+proposal.version)}<CleanupProposal {context} {proposal} finding={$controller.findings.find(f=>f.id===proposal.findingId)} current={$controller.selections[proposal.sourceId]} selected={$controller.selected.some(p=>p.id===proposal.id)} busy={$controller.loading} application={application(proposal)} onselect={checked=>controller.select(proposal,checked)} ondecide={decision=>void controller.decide(proposal.findingId,decision)} />{/each}
  {#if $controller.nextProposalsCursor}<button type="button" disabled={$controller.loading} onclick={()=>void controller.nextProposals()}>Next fixes</button>{/if}
  {#each $controller.findings.filter(f=>!$controller.proposals.some(p=>p.findingId===f.id)) as finding(finding.id)}<article class="cleanup-finding"><strong>{finding.kind.replaceAll('-',' ')}</strong><p>{finding.reason}</p>{#if finding.dismissed}<p>Reviewed</p>{:else}<button type="button" disabled={$controller.loading} onclick={()=>void controller.decide(finding.id,'keep')}>Keep current</button> <button type="button" disabled={$controller.loading} onclick={()=>void controller.decide(finding.id,'dismiss')}>Dismiss finding</button>{/if}</article>{/each}
  {#if $controller.nextFindingsCursor}<button type="button" disabled={$controller.loading} onclick={()=>void controller.nextFindings()}>Next findings</button>{/if}
  {#if !$controller.proposals.length&&!$controller.findings.length}<p>{$controller.run.state==='completed'?'No proposed fixes on this page.':'Suggestions will appear as inspection progresses.'}</p>{/if}
  {#each $controller.results.filter(row=>{try{return !!JSON.parse(row.outputJson??'{}').unresolved}catch{return true}}) as result(result.sourceId)}<p class="dim">Unresolved inspection: {result.sourceId}. A catalog was unavailable or this source needs a supported identity.</p>{/each}
  {#if $controller.applications.length}<h3>Saved batches</h3>{#each $controller.applications as receipt(receipt.id+receipt.sourceId)}<div class="cleanup-receipt"><span>{receipt.status} · {receipt.sourceId}</span>{#if receipt.status==='applied'&&Date.parse(receipt.undoExpiresAt)>Date.now()}<button type="button" disabled={$controller.loading} onclick={()=>void controller.undo(receipt)}>Undo saved fixes</button>{/if}</div>{/each}{/if}
  {#if $controller.nextApplicationsCursor}<button type="button" disabled={$controller.loading} onclick={()=>void controller.nextApplications()}>Older saved batches</button>{/if}
 {/if}
</section>
<style>.cleanup-page{min-width:0}.cleanup-approval{display:flex;gap:.7rem;align-items:center;flex-wrap:wrap;margin-block:1rem}.cleanup-receipt{display:flex;gap:1rem;justify-content:space-between;align-items:center;flex-wrap:wrap;overflow-wrap:anywhere;margin-block:.75rem}.cleanup-finding{padding:1rem;border-block-end:1px solid var(--border,#505050)}h2{outline:none}</style>
