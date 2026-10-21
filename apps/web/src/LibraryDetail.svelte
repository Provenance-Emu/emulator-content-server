<script lang="ts">
  import type { ManifestFile, PlayerCoreDescriptor, SourceFile } from '@ecs/client';
  import { onDestroy } from 'svelte';
  import type { ServerContext } from './lib/application';
  import type { DetailController } from './lib/detail';
  import { availabilityLabel, systemLabel } from './lib/content-format';
  import { explain } from './lib/problems';
  import { bytes } from './lib/format';
  import { sourcePlayHref } from './player/links';
  import Files from './Files.svelte';
  import MatchingPanel from './MatchingPanel.svelte';
  import Upload from './Upload.svelte';
  import Modal from './components/Modal.svelte';
  let {
    controller,
    context,
    playerCore,
    owner,
    selectedSource,
    onback,
    onchanged,
  }: {
    controller: DetailController;
    context: ServerContext;
    playerCore: PlayerCoreDescriptor | null;
    owner: boolean;
    selectedSource:SourceFile|null;
    onback: () => void;
    onchanged: () => void;
  } = $props();
  let upload = $state(false);
  let uploading = $state(false);
  let disposed = false;
  let groupDownloading=$state(false);
  let groupFailure=$state<string|null>(null);
  onDestroy(() => {
    disposed = true;
  });
  async function download(file?: ManifestFile) {
    const current = controller;
    const result = await current.download(file);
    if (!result || disposed || current !== controller) return;
    const url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/octet-stream' }));
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.name;
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function downloadMember(id:string) {
    const opened=controller;const result=await opened.downloadMember(id);
    if (!result || disposed || opened !== controller) return;
    const url=URL.createObjectURL(new Blob([result.bytes],{type:'application/octet-stream'}));
    try {const anchor=document.createElement('a');anchor.href=url;anchor.download=result.name;anchor.click();} finally {URL.revokeObjectURL(url);}
  }
  async function downloadBundle() {
    if(groupDownloading)return;
    groupDownloading=true;groupFailure=null;const opened=controller;
    try {
      // Request the native save destination during the click gesture, before network awaits.
      type SavePicker=(options:{suggestedName:string})=>Promise<{createWritable():Promise<WritableStream<Uint8Array>>}>;
      const picker=(window as Window & {showSaveFilePicker?:SavePicker}).showSaveFilePicker;
      const name=($controller.source?.name ?? 'disc-set').replace(/\.[^.]+$/,'')+'.zip';
      const destination=picker ? await picker.call(window,{suggestedName:name}) : null;
      const response=await opened.downloadBundle();
      if(!response || disposed || opened !== controller)return;
      if(destination && response.body) await response.body.pipeTo(await destination.createWritable());
      else {
        const blob=await response.blob();if(disposed || opened !== controller)return;
        const url=URL.createObjectURL(blob);
        try {const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();} finally {URL.revokeObjectURL(url);}
      }
    } catch(error){if(!disposed && !(error instanceof Error && error.name==='AbortError'))groupFailure=explain(error);}
    finally {if(!disposed)groupDownloading=false;}
  }
  async function adopt() {
    if (await controller.adopt()) onchanged();
  }
  const play = $derived($controller.source ? sourcePlayHref(playerCore, $controller.source) : null);
</script>

<button type="button" class="back-button" onclick={onback}>Back to collection</button>
<header class="page-heading">
  <div>
    <p class="eyebrow">
      {$controller.source ? 'Server folder file' : $controller.asset ? 'Library file' : 'Game'}
    </p>
    <h1 tabindex="-1" data-detail-heading>
      {$controller.entry?.name ?? 'File unavailable'}
    </h1>
    <p class="dim">
      {systemLabel($controller.entry?.systemId ?? null)}{#if $controller.revision !== null}
        · Revision {$controller.revision}{/if}
    </p>
  </div>
  <div class="actions">
    {#if $controller.canUpload && $controller.item}<button
        type="button"
        onclick={() => (upload = true)}
      >
        Add a file
      </button>{/if}
    <button
      type="button"
      disabled={$controller.loading || !!$controller.reading || $controller.adopting}
      onclick={() => {
        void controller.load();
      }}
    >
      Refresh details
    </button>
  </div>
</header>
{#if $controller.failure}<p class="problem" role="alert">
    {$controller.failure}
  </p>{/if}
{#if $controller.loading}<p role="status">Reading file details…</p>{/if}
{#if $controller.source}<section>
    <h2>Overview</h2>
    <p>{$controller.source.name}</p>
    <p>
      {bytes($controller.source.size)} · {availabilityLabel($controller.source.availability)}
    </p>
    <div class="actions">
      {#if play}<button type="button" onclick={() => context.openPlayer(play)}>Play</button>{/if}
      <button
        type="button"
        disabled={$controller.source.availability !== 'local' || !!$controller.reading}
        onclick={() => {
          void download();
        }}
      >
        Download {$controller.source.name}
      </button>
    </div>
    {#if $controller.groupError}<p class="problem">{$controller.groupError} Rescan this library folder after fixing its disc files.</p>{/if}
    {#if $controller.sourceFiles.length > 1}
      <h2>Disc set · {$controller.sourceFiles.length} files</h2>
      <button type="button" disabled={groupDownloading || !!$controller.reading || !!$controller.groupError} onclick={()=>void downloadBundle()}>{groupDownloading ? 'Downloading ZIP…' : 'Download complete set as ZIP'}</button>
      <p class="dim">The ZIP keeps the original folder layout so CUE and playlist references work.</p>
      {#if groupFailure}<p class="problem" role="alert">{groupFailure}</p>{/if}
      <ul>{#each $controller.sourceFiles as file (file.id)}<li>{file.name} · {bytes(file.size)} <button type="button" disabled={groupDownloading || !!$controller.reading || file.availability !== 'local'} onclick={()=>void downloadMember(file.id)}>Download file</button></li>{/each}</ul>
    {/if}
    {#if $controller.source.availability !== 'local'}<p class="dim">
        This file is unavailable while its server folder is offline.
      </p>{/if}
  </section>

{:else if $controller.item}<Files
    detailState={$controller}
    {playerCore}
    ondownload={(file) => {
      void download(file);
    }}
    onplay={(href) => context.openPlayer(href)}
  />
  {#if $controller.canAdopt}<section>
      <h2>Preserved save copy</h2>
      <p>
        Use this copy as the current save. The save it replaces stays beside it as a preserved copy.
      </p>
      <button
        type="button"
        disabled={$controller.adopting || !!$controller.reading}
        onclick={() => {
          void adopt();
        }}
      >
        {$controller.adopting ? 'Choosing…' : 'Use this copy'}
      </button>
    </section>{/if}{/if}
{#if $controller.reading}<p role="status">
    Downloading {$controller.reading.received} bytes{#if $controller.reading.total !== null}
      of {$controller.reading.total}{/if}
  </p>{/if}
{#if selectedSource}{#key context.key+':'+selectedSource.id}<MatchingPanel {context} {owner} {onchanged} sourceId={selectedSource.id} sourceName={selectedSource.name} />{/key}{/if}
{#if upload && $controller.canUpload && $controller.item}<Modal
    title="Add a file"
    busy={uploading}
    onclose={() => (upload = false)}
  >
    <Upload
      onbusy={(busy) => (uploading = busy)}
      client={context.client}
      libraryId={$controller.item.libraryId}
      item={$controller.item}
      oncomplete={() => {
        upload = false;
        void controller.load();
        onchanged();
      }}
    />
  </Modal>{/if}
