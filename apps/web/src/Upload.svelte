<script lang="ts">
  import { ContentError, type ContentClient, type Item, type SystemSummary } from '@ecs/client';
  import { onDestroy, untrack } from 'svelte';
  import { createUploadReview, type UploadReview as Review } from './lib/upload-review';
  import { createUploadQueue } from './lib/upload-queue';
  import { explain } from './lib/problems';
  import UploadReview from './UploadReview.svelte';
  import UploadQueue from './UploadQueue.svelte';
  let {
    client,
    libraryId,
    item,
    category,
    mode = 'files',
    oncomplete,
    onbusy = () => {},
    onauthorization = () => {},
  }: {
    client: ContentClient;
    libraryId: string;
    item: Item | null;
    category?: string;
    mode?: 'files' | 'folder';
    oncomplete: () => void;
    onbusy?: (busy: boolean) => void;
    onauthorization?: (status: 401 | 403) => void;
  } = $props();
  let systems = $state<SystemSummary[]>([]);
  let review = $state.raw<Review | null>(null);
  let failure = $state<string | null>(null);
  let started = $state(false);
  let disposed = false;
  let folderSupported = $state(false);
  const queue = untrack(() =>
    createUploadQueue(client, {
      libraryId,
      changed: oncomplete,
      authorizationRejected: rejectAuthorization,
    }),
  );
  const unsubscribe = queue.subscribe((state) => {
    if (!disposed) onbusy(state.running);
  });
  function rejectAuthorization(status: 401 | 403) {
    if (disposed) return;
    queue.dispose();
    review = null;
    onbusy(false);
    onauthorization(status);
  }
  async function load() {
    try {
      const result = await client.systems();
      if (disposed) return;
      systems = result.systems;
      review = createUploadReview({ libraryId, item, systems, category });
      folderSupported = 'webkitdirectory' in document.createElement('input');
    } catch (error) {
      if (disposed) return;
      if (error instanceof ContentError && (error.status === 401 || error.status === 403))
        rejectAuthorization(error.status);
      else failure = explain(error);
    }
  }
  function pick(event: Event) {
    const files = Array.from((event.currentTarget as HTMLInputElement).files ?? []);
    if (files.length) review?.selectFiles(files);
  }
  function start() {
    if (started || !review) return;
    const entries = review.validate();
    if (!entries) return;
    started = true;
    void queue.start(entries);
  }
  onDestroy(() => {
    disposed = true;
    unsubscribe();
    queue.dispose();
  });
  void load();
</script>
<section>
  <h2>{item?`Add files to ${item.title}`:'Upload from this device'}</h2>
  {#if !started}
    {#if review}
      <label>File<input type="file" multiple onchange={pick} /></label>
      {#if folderSupported}<label>Folder<input type="file" multiple {...{webkitdirectory:true}} onchange={pick} /></label>
      {:else}<p>Folder selection is unavailable in this browser. Use File to select multiple files.</p>{/if}
      {#if mode==='folder' && folderSupported}<p>Select a folder using Folder. Relative folder paths will be preserved.</p>{/if}
      <UploadReview controller={review} {systems} {client} {libraryId} onauthorization={rejectAuthorization} />
      <button type="button" disabled={!$review?.entries.length || $review?.entries.some(e=>e.errors.length)} onclick={start}>Upload</button>
    {:else if !failure}<p>Loading upload metadata…</p>{/if}
  {:else}<UploadQueue controller={queue} {client} {libraryId} onauthorization={rejectAuthorization} />{/if}
  {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
</section>
