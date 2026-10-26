<script lang="ts">
  import type { Item, ManifestFile, PlayerCoreDescriptor, SourceFile, SystemSummary } from '@ecs/client';
  import { onDestroy } from 'svelte';
  import type { ServerContext } from './lib/application';
  import type { DetailController } from './lib/detail';
  import { availabilityLabel, systemLabel } from './lib/content-format';
  import { explain } from './lib/problems';
  import { bytes } from './lib/format';
  import { chooseBrowserDownload } from './lib/browser-download';
  import { boundedDownloadBlob } from './lib/download-limits';
  import { sourcePlayHref } from './player/links';
  import Files from './Files.svelte';
  import MatchingPanel from './MatchingPanel.svelte';
  import SourceOrganization from './SourceOrganization.svelte';
  import Upload from './Upload.svelte';
  import Modal from './components/Modal.svelte';
  let {
    controller,
    context,
    playerCore,
    systems,
    owner,
    selectedSource,
    refreshing = false,
    onrefresh,
    onback,
    onchanged,
    onauthorization = () => {},
  }: {
    controller: DetailController;
    context: ServerContext;
    playerCore: PlayerCoreDescriptor | null;
    systems: SystemSummary[];
    owner: boolean;
    selectedSource:SourceFile|null;
    refreshing?: boolean;
    onrefresh: () => void;
    onback: () => void;
    onchanged: () => void;
    onauthorization?: (status:401|403) => void;
  } = $props();
  let upload = $state(false);
  let uploadTarget = $state.raw<Item|null>(null);
  let uploading = $state(false);
  let disposed = false;
  let groupDownloading=$state(false);
  let groupFailure=$state<string|null>(null);
  onDestroy(() => {
    disposed = true;
  });
  let saving = $state(false);
  let saveFailure = $state<string | null>(null);
  async function download(file?: ManifestFile, memberId?: string) {
    if (saving || groupDownloading) return;
    const current = controller;
    const source = memberId ? $controller.sourceFiles.find(row => row.id === memberId) : $controller.source;
    const selected = source ? null : $controller.files.find(row => row.id === (file?.id ?? $controller.asset?.id));
    if ((memberId && !source) || (!source && !selected)) return;
    const name = source?.name ?? selected?.relativePath.split('/').at(-1) ?? 'download';
    saving = true;
    saveFailure = null;
    try {
      const target = await chooseBrowserDownload(name);
      if (disposed || current !== controller) return;
      if (target) {
        const sink = await target.createSink();
        if (disposed || current !== controller) { await sink.abort().catch(() => undefined); return; }
        await current.downloadTo(sink, file, memberId);
        return;
      }
      const result = memberId ? await current.downloadMember(memberId) : await current.download(file);
      if (!result || disposed || current !== controller) return;
      const url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/octet-stream' }));
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = result.name;
        anchor.click();
      } finally { URL.revokeObjectURL(url); }
    } catch (error) {
      if (!disposed && current === controller && !(error instanceof Error && error.name === 'AbortError')) saveFailure = explain(error);
    } finally { if (!disposed) saving = false; }
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
        const blob=await boundedDownloadBlob(response);if(disposed || opened !== controller)return;
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
      {systemLabel($controller.entry?.systemId ?? null, systems)}
    </p>
  </div>
  <div class="actions">
    {#if $controller.canUpload && $controller.item}<button
        type="button"
        onclick={() => {uploadTarget=$controller.item;upload=true;}}
      >
        Add a file
      </button>{/if}
    <button
      type="button"
      disabled={saving || refreshing || $controller.loading || !!$controller.reading || $controller.adopting}
      onclick={onrefresh}
    >
      Refresh details
    </button>
  </div>
</header>
{#if saveFailure}<p class="problem" role="alert">{saveFailure}</p>{/if}
{#if saving && !$controller.reading}<p role="status">Choose where to save the file…</p>{/if}
{#if $controller.failure}<p class="problem" role="alert">
    {$controller.failure}
  </p>{/if}
{#if $controller.loading}<p role="status">Reading file details…</p>{/if}
{#if $controller.source}<section>
    {#if play}<h2>Ready to play</h2><p>Play here in your browser, or download the game file to use in your emulator.</p>
    {:else if $controller.source.kind === 'rom' && $controller.source.availability === 'local'}<h2>Take this game to your emulator</h2><p>Browser play is not available for this game on this server. Download it and open it in an emulator that supports this console.</p>
    {:else}<h2>File download</h2>{/if}
    <p>
      {bytes($controller.source.size)} · {availabilityLabel($controller.source.availability)}
    </p>
    <div class="actions">
      {#if play}<button class="primary" type="button" onclick={() => context.openPlayer(play)}>Play</button>{/if}
      <button
        type="button"
        disabled={saving || $controller.source.availability !== 'local' || !!$controller.reading}
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
      <button type="button" disabled={saving || groupDownloading || !!$controller.reading || !!$controller.groupError} onclick={()=>void downloadBundle()}>{groupDownloading ? 'Downloading ZIP…' : 'Download complete set as ZIP'}</button>
      <p class="dim">The ZIP keeps the original folder layout so CUE and playlist references work.</p>
      {#if groupFailure}<p class="problem" role="alert">{groupFailure}</p>{/if}
      <ul>{#each $controller.sourceFiles as file (file.id)}<li>{file.name} · {bytes(file.size)} <button type="button" disabled={saving || groupDownloading || !!$controller.reading || file.availability !== 'local'} onclick={()=>void download(undefined, file.id)}>Download file</button></li>{/each}</ul>
    {/if}
    {#if $controller.source.availability !== 'local'}<p class="dim">
        This file is unavailable while its server folder is offline.
      </p>{/if}
  </section>

{:else if $controller.item}<Files
    detailState={$controller}
    externalBusy={saving || groupDownloading}
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
{#if selectedSource}{#key context.key+':'+selectedSource.id}<MatchingPanel {context} {owner} {onchanged} sourceId={selectedSource.id} sourceName={selectedSource.name} />
{#if selectedSource.kind==='rom'}<SourceOrganization {context} {owner} sourceRootId={selectedSource.rootId} sourceId={selectedSource.id} libraryId={selectedSource.libraryId} onchanged={()=>{onchanged();onrefresh();}} />{/if}
{/key}{/if}
{#if upload && uploadTarget}<Modal
    title="Add a file"
    busy={uploading}
    onclose={() => (upload = false)}
  >
    <Upload
      {onauthorization}
      onbusy={(busy) => (uploading = busy)}
      client={context.client}
      libraryId={uploadTarget.libraryId}
      item={uploadTarget}
      oncomplete={() => {
        void controller.load();
        onchanged();
      }}
    />
  </Modal>{/if}
