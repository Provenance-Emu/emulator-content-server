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
  function pick(event: Event) {
    const files = Array.from((event.currentTarget as HTMLInputElement).files ?? []);
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
<section>
  <h2>{item ? `Add files to ${item.title}` : 'Upload from this device'}</h2>
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
      <label>File<input type="file" multiple onchange={pick} /></label>
      {#if folderSupported}<label>Folder<input type="file" multiple {...{webkitdirectory:true}} onchange={pick} /></label>
      {:else}<p>Folder selection is unavailable in this browser. Use File to select multiple files.</p>{/if}
      {#if mode==='folder' && folderSupported}<p>Select a folder using Folder. Relative folder paths will be preserved.</p>{/if}
      <UploadReview controller={review} {systems} {client} {libraryId} onauthorization={rejectAuthorization} />
      {#if journal && !temporaryOnly}<label><input type="checkbox" bind:checked={saveProgress} disabled={!!savedFailure || ($review?.entries.length ?? 0) > MAX_SAVED_UPLOADS} /> Save upload progress on this device</label>
        <p class="dim">Saves file names, transfer progress and content checks for this signed-in session. Files themselves are not stored. After reopening, select the originals to resume.</p>
        {#if ($review?.entries.length ?? 0) > MAX_SAVED_UPLOADS}<p>Save progress for up to {MAX_SAVED_UPLOADS} files at a time. Split this selection into smaller queues to keep recovery available.</p>{/if}
      {:else}<p class="dim">{temporaryOnly ? 'Keep this window open; this temporary queue is not saved after closing.' : credential ? 'This browser cannot store upload recovery. Keep this window open.' : 'Sign in to save upload progress after closing this window. Your browser must allow local storage.'}</p>{/if}
      <button type="button" disabled={!$review?.entries.length || $review?.entries.some(e=>e.errors.length)} onclick={start}>Upload</button>
    {:else if !failure}<p>Loading upload metadata…</p>{/if}
  {:else}<UploadQueue controller={queue} {client} {libraryId} onauthorization={rejectAuthorization} />{/if}
  {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
</section>
