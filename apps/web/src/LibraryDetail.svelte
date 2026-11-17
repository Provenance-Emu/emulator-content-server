<script lang="ts">
  import type { Item, ManifestFile, SourceFile, SystemSummary } from '@ecs/client';
  import { onDestroy } from 'svelte';
  import type { ServerContext } from './lib/application';
  import type { DetailController } from './lib/detail';
  import { systemLabel } from './lib/content-format';
  import { explain } from './lib/problems';
  import { chooseBrowserDownload } from './lib/browser-download';
  import { boundedDownloadBlob } from './lib/download-limits';
  import GameCopies from './GameCopies.svelte';
  import GameSource from './GameSource.svelte';
  import Files from './Files.svelte';
  import Upload from './Upload.svelte';
  import Modal from './components/Modal.svelte';
  import { moveToTrash, undoToast } from './lib/trash';
  let {
    controller,
    context,
    playerCore,
    systems,
    owner,
    canEdit = false,
    selectedSource,
    gameCompanions = false,
    refreshing = false,
    onrefresh,
    onback,
    onchanged,
    onauthorization = () => {},
    onemulators,
  }: {
    controller: DetailController;
    context: ServerContext;
    playerCore: import('./player/links').PlayableCores;
    systems: SystemSummary[];
    owner: boolean;
    /** May change this game's details and pictures: the owner, or an editor of its library. */
    canEdit?: boolean;
    selectedSource:SourceFile|null;
    gameCompanions?: boolean;
    refreshing?: boolean;
    onrefresh: () => void;
    onback: () => void;
    onchanged: () => void;
    onauthorization?: (status:401|403) => void;
    onemulators?: () => void;
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
  let trashing = $state(false);
  /** Reversible, so there is no confirmation. The toast carries the undo. */
  async function trash(target: { kind: 'item' | 'file'; id: string; name: string }) {
    if (trashing || saving) return;
    trashing = true;
    saveFailure = null;
    const leaving = target.kind === 'item';
    const failure = await moveToTrash(context.client, undoToast, target, () => {
      onchanged();
      if (!disposed && !leaving) onrefresh();
    });
    if (disposed) return;
    trashing = false;
    if (failure) saveFailure = failure;
    else if (leaving) onback();
  }
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
</script>

<button type="button" class="back-button" onclick={onback}>Back to collection</button>
{#if saveFailure}<p class="problem" role="alert">{saveFailure}</p>{/if}
{#if saving && !$controller.reading}<p role="status">Choose where to save the file…</p>{/if}
{#if $controller.failure}<p class="problem" role="alert">
    {$controller.failure}
  </p>{/if}
{#if $controller.loading}<p role="status">Reading file details…</p>{/if}
{#if selectedSource}
  {#key `${context.key}:${selectedSource.id}`}
    <GameSource
      {controller}
      {context}
      {playerCore}
      {systems}
      {owner}
      {canEdit}
      {selectedSource}
      {gameCompanions}
      {refreshing}
      {saving}
      {groupDownloading}
      {groupFailure}
      {onrefresh}
      {onchanged}
      {onauthorization}
      {onemulators}
      ondownload={(memberId) => void download(undefined, memberId)}
      ondownloadset={() => void downloadBundle()}
    />
  {/key}
{:else}
  <header class="page-heading">
    <div>
      <p class="eyebrow">{$controller.asset ? 'Library file' : 'Game'}</p>
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
      {#if $controller.canUpload && $controller.item && !$controller.asset}<button
          type="button"
          disabled={trashing || saving || $controller.loading || !!$controller.reading || $controller.adopting}
          onclick={() => {
            const item = $controller.item;
            if (item) void trash({ kind: 'item', id: item.id, name: item.title });
          }}
        >
          Move to trash
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
  {#if $controller.item}<Files
      detailState={$controller}
      externalBusy={saving || groupDownloading || trashing}
      {playerCore}
      {onemulators}
      ontrash={$controller.canUpload
        ? (file) => void trash({ kind: 'file', id: file.id, name: file.relativePath })
        : undefined}
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
      </section>{/if}
    {#key `${context.key}:${$controller.item.id}`}
      <GameCopies client={context.client} item={$controller.item} source={null}
        cores={playerCore} {owner} onchanged={() => { onchanged(); onrefresh(); }} onplay={(href) => context.openPlayer(href)} />
    {/key}
  {/if}
{/if}
{#if $controller.reading}<p role="status">
    Downloading {$controller.reading.received} bytes{#if $controller.reading.total !== null}
      of {$controller.reading.total}{/if}
  </p>{/if}
{#if upload && uploadTarget}<Modal
    title="Add a file"
    busy={uploading}
    onclose={() => (upload = false)}
  >
    <Upload
      serverContext={context}
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
