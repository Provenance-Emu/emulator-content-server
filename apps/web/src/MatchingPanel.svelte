<script lang="ts">
  import { ContentError, type MatchingCandidate, type MatchingPlugin } from '@ecs/client';
  import { onMount, onDestroy, untrack } from 'svelte';
  import type { ServerContext } from './lib/application';
  import { createMatching } from './lib/matching';
  import { explain } from './lib/problems';
  let {context,sourceId,sourceName}:{context:ServerContext;sourceId:string;sourceName:string}=$props();
  const controller=untrack(()=>createMatching(context.client,sourceId));
  let plugins=$state<MatchingPlugin[]>([]);
  let providerIds=$state<string[]>([]);
  let managerId=$state('org.ecs.matches');
  let online=$state(false);
  let checksum=$state(false);
  let failure=$state<string|null>(null);
  let ready=$state(false);
  let disposed=false;
  let category=$state('metadata');
  let page=$state(0);
  const categories=[['metadata','Metadata'],['artwork','Artwork'],['patch','Patches'],['rom','System matching'],['cheats','Cheats']] as const;
  const candidates=$derived($controller.result?.candidates.filter((c)=>c.kind===category) ?? []);
  const container=$derived(/\.(zip|7z|chd|cdi|iso|cue|m3u|gdi|ccd)$/i.test(sourceName));
  onMount(()=>{void context.client.matchingPlugins().then((registry)=>{
    if(disposed)return;
    plugins=registry.plugins;providerIds=plugins.filter((p)=>p.kind==='provider').map((p)=>p.id);ready=true;
  },(error)=>{if(!disposed)failure=explain(error);});});
  onDestroy(()=>{disposed=true;controller.dispose();});
  async function find(){page=0;failure=null;await controller.find({online,checksum:checksum&&!container,providerIds,managerId});}
  function providerName(id:string){return plugins.find((p)=>p.id===id)?.name ?? id;}
  async function download(candidate:MatchingCandidate){
    if(!candidate.fileId)return;
    try {
      const result=await context.client.collectSource(candidate.fileId,{maxBytes:2*1024*1024});
      if(disposed)return;
      const url=URL.createObjectURL(new Blob([result.bytes],{type:'application/octet-stream'}));
      try {const link=document.createElement('a');link.href=url;link.download=candidate.title+'.'+(candidate.metadata.format ?? 'patch');link.click();} finally {URL.revokeObjectURL(url);}
    } catch(error){if(!disposed){if(error instanceof ContentError && [401,403,404].includes(error.status))controller.clear();failure=explain(error);}}
  }
</script>

<section class="matching" aria-label="Metadata and artwork matching">
  <h2>Metadata, artwork & patches</h2>
  <p class="dim">Find suggestions from files beside this game and your selected providers. These previews leave your files and saved library metadata unchanged.</p>
  <div class="match-options">
    <label><input type="checkbox" bind:checked={online} disabled={$controller.loading} /> Include online providers</label>
    <label><input type="checkbox" bind:checked={checksum} disabled={container || $controller.loading} /> Verify by checksum (local ROMs up to 64 MB)</label>
  </div>
  <p class="dim">Online lookup downloads public Libretro catalogs. Artwork loads when you choose Preview. ROM bytes and server paths stay on this machine.</p>
  {#if container}<p class="dim">Disc sets and archives use filename suggestions; a container checksum cannot identify the game inside.</p>{/if}
  <details>
    <summary>Providers and manager</summary>
    <label>Match manager <select bind:value={managerId} disabled={$controller.loading}>{#each plugins.filter((p)=>p.kind==='manager') as plugin (plugin.id)}<option value={plugin.id}>{plugin.name}</option>{/each}</select></label>
    <fieldset disabled={$controller.loading}>
      <legend>Matching providers</legend>
      {#each plugins.filter((p)=>p.kind==='provider') as plugin (plugin.id)}
        <label><input type="checkbox" bind:group={providerIds} value={plugin.id} disabled={plugin.network&&!online} /> {plugin.name} · {plugin.capabilities.join(', ')} {plugin.network ? '(online)' : '(local)'}</label>
      {/each}
    </fieldset>
    <p class="dim">Provider plugins find candidates. Manager plugins choose which providers run. Install JavaScript plugins on the server with <code>--matching-plugins</code>.</p>
  </details>
  <button type="button" disabled={!ready||$controller.loading||!providerIds.length} onclick={()=>void find()}>{$controller.loading ? 'Finding matches…' : 'Find matches'}</button>
  {#if $controller.result}<button type="button" onclick={()=>controller.clear()}>Clear matches</button>{/if}
  {#if failure||$controller.failure}<p role="alert" class="problem">{failure ?? $controller.failure}</p>{/if}
  {#if $controller.result}
    {#each $controller.result.problems as problem}<p class="problem">{providerName(problem.providerId)} could not complete its lookup. Other results are still available.</p>{/each}
    <div class="actions" aria-label="Match categories">
      {#each categories as [id,label]}<button type="button" class:active={category===id} aria-pressed={category===id} onclick={()=>{category=id;page=0;}}>{label} ({$controller.result.candidates.filter((c)=>c.kind===id).length})</button>{/each}
    </div>
    {#if !candidates.length}<p>No {categories.find(([id])=>id===category)?.[1]?.toLowerCase()} suggestions from the selected providers.</p>{/if}
    <div class="match-results">
      {#each candidates.slice(page*8,page*8+8) as candidate (candidate.id)}
        <article>
          <h3>{candidate.title}</h3>
          <p class="dim">{providerName(candidate.providerId)} · {candidate.confidence==='checksum' ? 'Checksum and size match' : candidate.confidence==='local' ? 'Local filename association' : 'Filename suggestion — verify the edition'}</p>
          {#if candidate.kind==='artwork'}
            {#if $controller.artwork[candidate.id]}<img src={$controller.artwork[candidate.id]} alt={'Artwork suggestion for '+candidate.title} />
            {:else}<button type="button" disabled={!!$controller.previewing} onclick={()=>void controller.preview(candidate.id)}>{$controller.previewing===candidate.id ? 'Loading preview…' : 'Preview artwork'}</button>{/if}
          {:else}<dl>{#each Object.entries(candidate.metadata) as [key,value]}<dt>{key}</dt><dd>{String(value)}</dd>{/each}</dl>{/if}
          {#if candidate.kind==='patch'&&candidate.fileId}<button type="button" onclick={()=>void download(candidate)}>Download patch</button>{/if}
        </article>
      {/each}
    </div>
    {#if candidates.length>8}<div class="actions"><button type="button" disabled={page===0} onclick={()=>page--}>Previous matches</button><span>Page {page+1}</span><button type="button" disabled={(page+1)*8>=candidates.length} onclick={()=>page++}>Next matches</button></div>{/if}
  {/if}
</section>

<style>
  .matching { margin-top:2rem; border-top:1px solid var(--border, #444); padding-top:1rem; }
  .match-options, fieldset { display:flex; flex-wrap:wrap; gap:1rem; margin:1rem 0; }
  fieldset { flex-direction:column; }
  details { margin:1rem 0; }
  .match-results { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr)); gap:1rem; margin:1rem 0; }
  article { border:1px solid var(--border,#444); padding:1rem; border-radius:.6rem; overflow-wrap:anywhere; }
  h3 { margin-top:0; }
  img { display:block; width:100%; max-width:18rem; max-height:24rem; object-fit:contain; }
  dt { font-weight:600; text-transform:capitalize; }
  dd { margin:0 0 .6rem; white-space:pre-wrap; }
  .active { outline:2px solid currentColor; }
</style>
