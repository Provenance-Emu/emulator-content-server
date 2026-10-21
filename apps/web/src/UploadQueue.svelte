<script lang="ts">
  import type { ContentClient } from '@ecs/client';
  import type { UploadQueue } from './lib/upload-queue';
  import UploadTargetPicker from './UploadTargetPicker.svelte';
  let {
    controller,
    client,
    libraryId,
  }: {
    controller: UploadQueue;
    client: ContentClient;
    libraryId: string;
  } = $props();
  let picking = $state<string | null>(null);
  const successes = $derived($controller.entries.filter((e) => e.state === 'succeeded').length);
</script>
<section aria-label="Upload queue" aria-live="polite">
  <h3>Upload queue</h3>
  <p>{successes} succeeded · {$controller.entries.length-successes} unfinished</p>
  <p class="dim">Keep this page open. This queue is not saved across reloads.</p>
  {#if $controller.running}<button type="button" disabled={$controller.stopping} onclick={()=>controller.stopAfterCurrent()}>Stop after current file</button>{#if $controller.stopping}<p>Stopping after the current file finishes. Its server commit may still complete.</p>{/if}
  {:else if $controller.entries.some(e=>e.state==='waiting'||e.state==='failed')}<button type="button" onclick={()=>void controller.retryUnfinished()}>Retry unfinished uploads</button>{/if}
  {#if $controller.status===401 || $controller.status===403}<p role="alert" class="problem">Upload authorization was lost. Sign in or restore access before retrying.</p>{/if}
  {#if picking}<UploadTargetPicker {client} {libraryId} oncancel={()=>picking=null} onchoose={item=>{if(picking)controller.reconcile(picking,item);picking=null;}} />{/if}
  {#each ['unfinished','successful'] as group}
    <h4>{group==='unfinished'?'Unfinished files':'Successful files'}</h4>
    <ul class="upload-entries">
      {#each $controller.visible.filter(e=>group==='successful'?e.state==='succeeded':e.state!=='succeeded') as entry (entry.id)}
        <li><strong>{entry.relativePath}</strong> · {entry.state}
          <progress aria-label={`Progress for ${entry.file.name}`} max={entry.file.size||1} value={entry.sent}></progress>
          <span>{entry.sent} of {entry.file.size} bytes</span>
          {#if entry.failure}<p class="problem">{entry.failure}</p>{/if}
          {#if entry.state==='failed'}<p>Retry uses the same item, file, and transfer key.</p>{/if}
          {#if entry.state==='reconciliation-required'}<p role="alert">The server may have created this game. Check the managed items and choose the correct target before retrying.</p><button type="button" disabled={$controller.running} onclick={()=>picking=entry.id}>Reconcile {entry.file.name}</button>{/if}
        </li>
      {/each}
    </ul>
  {/each}
  <nav aria-label="Queue pages"><button type="button" disabled={$controller.page===0} onclick={()=>controller.page($controller.page-1)}>Previous queue files</button><span>Page {$controller.page+1} of {$controller.pages}</span><button type="button" disabled={$controller.page+1===$controller.pages} onclick={()=>controller.page($controller.page+1)}>Next queue files</button></nav>
</section>
<style>
  .upload-entries { padding-inline-start:1.5rem; }
  li { padding:.75rem 0; border-top:1px solid var(--line); overflow-wrap:anywhere; }
  progress { display:block; width:100%; margin-block:.5rem; }
  nav { display:flex; flex-wrap:wrap; gap:.75rem; align-items:center; margin-block:1rem; }
</style>
