<script lang="ts">
 import type {WorkflowProposal,WorkflowFinding,WorkflowApplication,SourceMatchSelections,SavedSourceMatch} from '@ecs/client';
 import type {ServerContext} from './lib/application';
 import {explain} from './lib/problems';
 let {context,proposal,finding,current,selected,busy,application,onselect,ondecide}:{context:ServerContext;proposal:WorkflowProposal;finding?:WorkflowFinding;current?:SourceMatchSelections;selected:boolean;busy:boolean;application?:WorkflowApplication;onselect:(checked:boolean)=>void;ondecide:(decision:'keep'|'dismiss')=>void}=$props();
 const snapshot=$derived.by(()=>{try{return JSON.parse(proposal.change.snapshotJson) as SavedSourceMatch}catch{return null}});
 const art=$derived(proposal.change.action==='replace-front-artwork');
 const before=$derived(current?.matches.find(m=>art?m.kind==='artwork'&&(m.artworkRole??'front')==='front':m.kind===(proposal.change.action==='replace-system'?'rom':'metadata')));
 const stale=$derived(!!current&&current.revision!==proposal.selectionRevision);
 const applied=$derived(application?.status==='applied');
 let proposedUrl=$state<string|null>(null),beforeUrl=$state<string|null>(null),imageFailure=$state<string|null>(null),evidence=$state<string[]>([]),evidenceLoading=$state(false);
 const label=$derived(art?'Front cover':proposal.change.action==='replace-system'?'System':'Game details');
 const classes:Record<string,string>={'verified-source':'Verified source identity','saved-selection':'Based on saved selection',local:'Local sidecar',filename:'Filename suggestion',unverified:'Unverified suggestion'};
 $effect(()=>{
  const p=proposal,isArt=art,revision=current?.revision,hasBefore=before?.contentAvailable;const abort=new AbortController();let live=true;const urls:string[]=[];proposedUrl=beforeUrl=null;imageFailure=null;
  if(isArt&&p.change.artifactId)void (async()=>{try{const result=await context.client.workflowArtifact(p.runId,p.sourceId,p.change.artifactId!,abort.signal);const info=await context.client.workflowArtifactInfo(p.runId,p.sourceId,p.change.artifactId!);if(!live)return;const url=URL.createObjectURL(new Blob([result.bytes],{type:info.artifact.contentType}));urls.push(url);proposedUrl=url}catch(error){if(live)imageFailure=explain(error)}})();
  if(isArt&&hasBefore)void (async()=>{try{const blob=await context.client.selectedMatchContent(p.sourceId,'artwork',abort.signal,'front');if(!live)return;const url=URL.createObjectURL(blob);urls.push(url);beforeUrl=url}catch{/* The text still shows an unavailable selected cover. */}})();
  void revision;return()=>{live=false;abort.abort();urls.forEach(url=>URL.revokeObjectURL(url))};
 });
 async function showEvidence(){evidenceLoading=true;try{const rows=await Promise.all(proposal.evidenceIds.map(id=>context.client.workflowEvidence(proposal.runId,proposal.sourceId,id)));evidence=rows.map(({evidence})=>{const payload=JSON.parse(evidence.payloadJson);return payload.type==='candidate'?`${payload.providerId}: ${payload.title}`:payload.type==='facts'?`Source inspected: ${payload.facts?.name??proposal.sourceName??proposal.sourceId}`:'Recorded observation'})}catch(error){evidence=[explain(error)]}finally{evidenceLoading=false}}
</script>
<article class="cleanup-proposal" data-testid="cleanup-proposal" aria-label={`${proposal.sourceName??'Game'}: ${label}`}>
 <div class="cleanup-card-heading"><label><input type="checkbox" checked={selected} disabled={busy||stale||applied||finding?.dismissed||!current} onchange={event=>onselect(event.currentTarget.checked)} /> Select {label.toLowerCase()} fix</label><span>{classes[proposal.evidenceClass??'unverified']}</span></div>
 <h3>{proposal.sourceName??snapshot?.title??'Unavailable source'}</h3>
 <div class="cleanup-comparison">
  <section aria-label="Current selection"><h4>Current</h4>{#if beforeUrl}<img src={beforeUrl} alt="Current front cover" />{/if}<p>{before?.title??(art?'No saved front cover':'No saved details')}</p>{#if before?.metadata.systemId}<p>{String(before.metadata.systemId)}</p>{/if}</section>
  <section aria-label="Proposed selection"><h4>Proposed</h4>{#if proposedUrl}<img src={proposedUrl} alt="Proposed front cover" />{/if}<p>{snapshot?.title??'Unavailable proposal'}</p>{#if snapshot?.metadata.systemId}<p>{String(snapshot.metadata.systemId)}</p>{/if}{#if snapshot?.metadata.publisher}<p>{String(snapshot.metadata.publisher)}</p>{/if}</section>
 </div>
 <p>{finding?.kind.replaceAll('-',' ')}: {proposal.reason}</p>
 {#if imageFailure}<p class="problem">{imageFailure}</p>{/if}
 {#if application}<p role="status">{application.status==='applied'?'Saved':application.status==='undone'?'Undone': 'Skipped: the source or selection changed. Run inspection again.'}</p>{:else if stale}<p role="status">This selection changed. Run inspection again to review a fresh fix.</p>{/if}
 {#if finding?.dismissed}<p>Reviewed; no fix was saved.</p>{:else}<div class="matching-actions"><button type="button" disabled={busy||applied} onclick={()=>ondecide('keep')}>Keep current</button><button type="button" disabled={busy||applied} onclick={()=>ondecide('dismiss')}>Dismiss finding</button></div>{/if}
 <details><summary>Evidence ({proposal.evidenceIds.length})</summary><button type="button" disabled={evidenceLoading} onclick={()=>void showEvidence()}>Load evidence</button>{#each evidence as row}<p>{row}</p>{/each}</details>
</article>
<style>
 .cleanup-proposal{border:1px solid var(--border,#505050);border-radius:8px;padding:1rem;margin-block:1rem;min-width:0;overflow-wrap:anywhere}.cleanup-card-heading{display:flex;justify-content:space-between;gap:.75rem;flex-wrap:wrap}.cleanup-card-heading label{display:flex;flex-direction:row;align-items:center;gap:.5rem}.cleanup-card-heading input{width:1.15rem;height:1.15rem;flex:0 0 auto;margin:0}.cleanup-card-heading span{font-size:.85rem;opacity:.75}.cleanup-comparison{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.cleanup-comparison section{min-width:0}.cleanup-comparison h4{margin:.4rem 0}.cleanup-comparison img{display:block;max-width:100%;height:160px;object-fit:contain}.cleanup-comparison p{margin:.5rem 0}.cleanup-proposal h3{font-size:1rem;margin:.8rem 0}
 @media(max-width:450px){.cleanup-proposal{padding:.75rem}.cleanup-comparison{gap:.5rem}.cleanup-comparison img{height:120px}}
</style>
