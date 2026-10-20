<script lang="ts">
  import type { ManifestFile, PlayerCoreDescriptor } from '@ecs/client';
  import { onDestroy } from 'svelte';
  import type { ServerContext } from './lib/application';
  import type { DetailController } from './lib/detail';
  import { availabilityLabel, systemLabel } from './lib/content-format';
  import { bytes } from './lib/format';
  import { sourcePlayHref } from './player/links';
  import Files from './Files.svelte';
  import Upload from './Upload.svelte';
  import Modal from './components/Modal.svelte';
  let {
    controller,
    context,
    playerCore,
    onback,
    onchanged,
  }: {
    controller: DetailController;
    context: ServerContext;
    playerCore: PlayerCoreDescriptor | null;
    onback: () => void;
    onchanged: () => void;
  } = $props();
  let upload = $state(false);
  let uploading = $state(false);
  let disposed = false;
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
