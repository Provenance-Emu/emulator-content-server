<script lang="ts">
  import { ContentError, type ContentClient, type Item, type SystemSummary } from '@ecs/client';
  import { onDestroy, untrack } from 'svelte';
  import type { ServerContext } from './lib/application';
  import { createUploadReview, type UploadReview as Review } from './lib/upload-review';
  import { createUploadQueue } from './lib/upload-queue';
  import { createUploadJournal } from './lib/upload-journal';
  import { MAX_SAVED_UPLOADS, type UploadCheckpointRecord } from './lib/upload-checkpoint';
  import { explain } from './lib/problems';
  import UploadReview from './UploadReview.svelte';
  import UploadQueue from './UploadQueue.svelte';
  import Icon from './components/Icon.svelte';
  let { client, serverContext, libraryId, item, category, mode = 'files', oncomplete, onbusy = () => {}, onauthorization = () => {} }: {
    client: ContentClient; serverContext: ServerContext; libraryId: string; item: Item | null; category?: string;
    mode?: 'files' | 'folder'; oncomplete: () => void; onbusy?: (busy: boolean) => void;
    onauthorization?: (status: 401 | 403) => void;
  } = $props();
  let systems = $state<SystemSummary[]>([]);
  let review = $state.raw<Review | null>(null);
  let failure = $state<string | null>(null);
  let savedFailure = $state<string | null>(null);
  let saved = $state<UploadCheckpointRecord | null>(null);
  let saveProgress = $state(false);
  let temporaryOnly = $state(false);
  let loadingSaved = $state(true);
  let started = $state(false);
  let disposed = false;
  let folderSupported = $state(false);
  const credential = untrack(() => serverContext.sessions.load()?.token ?? '');
  const isCurrent = () => !disposed && (serverContext.sessions.load()?.token ?? '') === credential;
  const journal = untrack(() => createUploadJournal(serverContext.origin, credential, libraryId, item?.id ?? null, isCurrent));
  const queue = untrack(() => createUploadQueue(client, { libraryId, itemId: item?.id ?? null, journal, isCurrent,
    changed: oncomplete, authorizationRejected: rejectAuthorization }));
  const unsubscribe = queue.subscribe(state => { if (!disposed) onbusy(state.running || !!state.checking); });
  function rejectAuthorization(status: 401 | 403) {
    if (disposed) return;
    queue.dispose(); review = null; saved = null; onbusy(false); onauthorization(status);
  }
  async function load() {
    try {
      const result = await client.systems();
      if (!isCurrent()) return;
      systems = result.systems;
      review = createUploadReview({ libraryId, item, systems, category });
      folderSupported = 'webkitdirectory' in document.createElement('input');
      if (journal) await readSaved();
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ContentError && (error.status === 401 || error.status === 403)) rejectAuthorization(error.status);
      else failure = explain(error);
    } finally { if (!disposed) loadingSaved = false; }
  }
  async function readSaved() {
    if (!journal || !isCurrent()) return;
    loadingSaved = true;
    try { const record = await journal.read(); if (isCurrent()) { saved = record; savedFailure = null; } }
    catch (error) { if (isCurrent()) savedFailure = explain(error); }
    finally { if (!disposed) loadingSaved = false; }
  }
  let over = $state(false);
  let fileInput = $state<HTMLInputElement>();
  let folderInput = $state<HTMLInputElement>();
  function pick(event: Event) {
    const files = Array.from((event.currentTarget as HTMLInputElement).files ?? []);
    if (files.length) review?.selectFiles(files);
  }
  function dropped(event: DragEvent) {
    event.preventDefault();
    over = false;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) review?.selectFiles(files);
  }
  function start() {
    if (started || !review || loadingSaved || saved || savedFailure) return;
    const entries = review.validate(); if (!entries) return;
    started = true;
    void queue.start(entries, saveProgress);
  }
  function recover() {
    if (!saved || !isCurrent()) return;
    try { queue.restore(saved); started = true; saved = null; }
    catch (error) { failure = explain(error); }
  }
  async function discard() {
    if (!journal || !isCurrent() || loadingSaved) return;
    loadingSaved = true;
    try {
      if (saved) await journal.remove(saved.revision);
      else if (journal.discard) await journal.discard();
      if (isCurrent()) { saved = null; savedFailure = null; }
    } catch (error) { if (isCurrent()) savedFailure = explain(error); }
    finally { if (!disposed) loadingSaved = false; }
  }
  onDestroy(() => { disposed = true; unsubscribe(); queue.dispose(); });
  void load();
</script>
<section class="upload">
  {#if item}<p class="dim upload-for">Adding to {item.title}</p>{/if}
  {#if !started}
    {#if loadingSaved}<p role="status">Checking upload progress…</p>
    {:else if saved}<section aria-label="Saved uploads"><h3>Unfinished uploads found</h3>
      <p>{saved.snapshot.entries.filter(e=>e.phase==='succeeded').length} succeeded · {saved.snapshot.entries.filter(e=>e.phase!=='succeeded').length} unfinished</p>
      <p>Recover the queue, then select the original files to continue. Their contents are checked before uploading.</p>
      <div class="actions"><button type="button" class="primary" onclick={recover}>Recover uploads</button><button type="button" onclick={()=>void discard()}>Discard saved progress</button></div>
    </section>
    {:else if savedFailure}<p class="problem" role="alert">Saved upload progress could not be read. {savedFailure}</p>
      <p>Starting a temporary queue uploads from the beginning. Check your library first to avoid repeating an earlier upload.</p>
      <div class="actions"><button type="button" onclick={()=>void readSaved()}>Retry saved progress</button><button type="button" onclick={()=>void discard()}>Discard saved progress</button><button type="button" onclick={()=>{temporaryOnly=true;saveProgress=false;savedFailure=null;}}>Start a temporary queue</button></div>
    {:else if review}
      {@const chosen = $review?.entries.length ?? 0}
      <div
        class="drop-zone"
        class:over
        class:compact={chosen > 0}
        role="group"
        aria-label="Choose what to upload"
        ondragover={(event) => { event.preventDefault(); over = true; }}
        ondragleave={() => (over = false)}
        ondrop={dropped}
      >
        {#if !chosen}
          <Icon name="upload" />
          <p><strong>Drop games, saves or pictures here</strong></p>
          <p class="dim">or choose them from this device</p>
        {/if}
        <div class="actions">
          <button type="button" class:primary={!chosen} onclick={() => fileInput?.click()}>
            {chosen ? 'Choose different files' : 'Choose files'}
          </button>
          <input bind:this={fileInput} class="visually-hidden" tabindex="-1" type="file" multiple aria-label="File" onchange={pick} />
          {#if folderSupported}
            <button type="button" onclick={() => folderInput?.click()}>
              {chosen ? 'Choose a different folder' : 'Choose a folder'}
            </button>
            <input bind:this={folderInput} class="visually-hidden" tabindex="-1" type="file" multiple aria-label="Folder" {...{webkitdirectory:true}} onchange={pick} />
          {/if}
        </div>
        {#if !folderSupported}<p class="dim">Folder selection is unavailable in this browser. Choose several files instead.</p>
        {:else if mode==='folder' && !chosen}<p class="dim">A folder keeps its layout, so disc sets stay together.</p>{/if}
      </div>
      {#if chosen}
        <UploadReview controller={review} {systems} {client} {libraryId} onauthorization={rejectAuthorization} />
        {#if journal && !temporaryOnly}
          <div class="upload-save">
            <label class="check"><input type="checkbox" bind:checked={saveProgress} disabled={!!savedFailure || chosen > MAX_SAVED_UPLOADS} /> Save upload progress on this device</label>
            <p class="dim">If this window closes, choose the same files again to carry on where it stopped. Only names and progress are kept, not the files.</p>
            {#if chosen > MAX_SAVED_UPLOADS}<p class="dim">Progress can be saved for up to {MAX_SAVED_UPLOADS} files at a time. Upload in smaller groups to keep it.</p>{/if}
          </div>
        {:else}<p class="dim">{temporaryOnly ? 'Keep this window open; this temporary queue is not saved after closing.' : credential ? 'This browser cannot store upload recovery. Keep this window open.' : 'Sign in to save upload progress after closing this window. Your browser must allow local storage.'}</p>{/if}
        <div class="ui-actions">
          <button type="button" class="primary" disabled={$review?.entries.some(e=>e.errors.length)} onclick={start}>Upload</button>
        </div>
      {/if}
    {:else if !failure}<p>Loading upload metadata…</p>{/if}
  {:else}<UploadQueue controller={queue} {client} {libraryId} onauthorization={rejectAuthorization} />{/if}
  {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
</section>
<style>
  .upload { display: grid; gap: var(--space-4); }
  .upload-for { margin: 0; }
  .drop-zone {
    display: grid;
    justify-items: center;
    gap: var(--space-2);
    padding: var(--space-8) var(--space-4);
    border: var(--border-width) dashed var(--color-border-strong);
    border-radius: var(--radius-panel);
    text-align: center;
    transition: background var(--motion-control) var(--ease-out);
  }
  .drop-zone p { margin: 0; }
  .drop-zone.over { background: var(--color-hover); }
  .drop-zone.compact { justify-items: start; padding: var(--space-3); text-align: left; }
  .drop-zone .actions { justify-content: center; margin-top: var(--space-2); }
  .drop-zone.compact .actions { margin-top: 0; }
  .upload-save { display: grid; gap: var(--space-1); }
  .upload-save p { margin: 0; font-size: var(--text-small); }
</style>
