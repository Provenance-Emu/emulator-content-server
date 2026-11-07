<script lang="ts">
  import type { ContentClient } from '@ecs/client';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { createLibraryFolders } from './lib/library-folders';
  import { chooseFolder, type FolderContext } from './lib/folder-selection';
  import { explain } from './lib/problems';
  import FolderPicker from './FolderPicker.svelte';
  import Upload from './Upload.svelte';
  import type { ServerContext } from './lib/application';
  let {
    client,
    context,
    serverContext,
    libraryId,
    onbusy,
  }: {
    client: ContentClient;
    context: FolderContext;
    serverContext: ServerContext;
    libraryId: string;
    onbusy: (busy: boolean) => void;
  } = $props();
  const folders = untrack(() => createLibraryFolders(client, context, { libraryId }));
  let picking = $state(false),
    choosing = $state(false),
    uploading = $state(false),
    copying = $state(false);
  let failure = $state<string | null>(null);
  let copied = $state(false);
  let disposed = false;
  $effect(() => {
    onbusy($folders.busy || choosing || uploading || picking);
  });
  onMount(() => {
    void folders.load({ libraryId });
  });
  onDestroy(() => {
    disposed = true;
    folders.dispose();
    onbusy(false);
  });
  async function choose() {
    failure = null;
    if (!context.folderSelection) {
      picking = true;
      return;
    }
    choosing = true;
    try {
      const selection = await chooseFolder(context, 'library-folder');
      if (selection && !disposed) await folders.add(selection);
    } catch (error) {
      if (!disposed) failure = explain(error);
    } finally {
      if (!disposed) choosing = false;
    }
  }
</script>

<p>Choose the folder that holds your games. Emulation Server will find the games inside it.</p>
<p class="dim">
  The folder must be on the computer running this library. You can add more folders later.
</p>
<button
  class="primary"
  type="button"
  disabled={$folders.busy || choosing || picking || uploading}
  onclick={() => void choose()}
  >{choosing
    ? 'Opening folder chooser…'
    : $folders.busy
      ? 'Finding your games…'
      : 'Choose games folder'}</button
>
{#if $folders.summaries.length}
  <ul class="setup-folder-list">
    {#each $folders.summaries as summary (summary.root.id)}<li>
        <strong>{summary.root.label}</strong><span>
          · {summary.indexedFileCount}
          {summary.indexedFileCount === 1 ? 'file' : 'files'} found</span
        >
        {#if $folders.scanFailures[summary.root.id]}<p class="problem" role="alert">
            {$folders.scanFailures[summary.root.id]}
          </p>
          <button
            type="button"
            disabled={$folders.busy}
            onclick={() => void folders.retryScan(summary.root.id)}>Try finding games again</button
          >{/if}
      </li>{/each}
  </ul>
{/if}
{#if $folders.existingRoot}<p>This folder is already saved. Add it to this library?</p>
  <button type="button" disabled={$folders.busy} onclick={() => void folders.linkExisting()}
    >Use this folder</button
  >{/if}
{#if $folders.failure || failure}<p class="problem" role="alert">
    {$folders.failure ?? failure}
  </p>{/if}
{#if $folders.notice}<p role="status">{$folders.notice}</p>{/if}
{#if picking}<FolderPicker
    {client}
    contextKey={context.key}
    origin={context.origin}
    title="Choose games folder"
    submitLabel="Use this folder"
    onsubmit={(selection) => folders.add(selection)}
    oncancel={() => (picking = false)}
  />{/if}
<details class="setup-alternative">
  <summary>My games are on this device instead</summary>
  <p>Copy files from this device into the library.</p>
  <button
    type="button"
    disabled={$folders.busy || choosing || uploading}
    onclick={() => (copying = !copying)}>Choose files to copy</button
  >
  {#if copying}<Upload
      {client}
      {libraryId}
      {serverContext}
      item={null}
      onbusy={(busy) => (uploading = busy)}
      onauthorization={(status) => context.onrejected?.(status)}
      oncomplete={() => {
        copied = true;
        void context.onchanged?.();
      }}
    />{/if}
  {#if copied}<p role="status">Your files have been added.</p>{/if}
</details>
<p class="dim">You can continue now and add games later.</p>

<style>
  .setup-folder-list {
    padding-left: 1.25rem;
  }
  li {
    margin-block: 0.75rem;
  }
</style>
