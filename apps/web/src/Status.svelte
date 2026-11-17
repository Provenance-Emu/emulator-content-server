<script lang="ts">
  import type { Capabilities } from '@ecs/client';
  import Icon from './components/Icon.svelte';

  let { capabilities, reachable }: { capabilities: Capabilities | null; reachable: boolean } =
    $props();

  const features = $derived(
    capabilities
      ? [
          ['Ranges', capabilities.features.rangeRequests],
          ['Resumable uploads', capabilities.features.resumableUploads],
          ['Change feed', capabilities.features.changeFeed],
          ['Guest links', capabilities.features.guestGrants],
          ['WebDAV', capabilities.features.webdav],
          ...capabilities.features.virtualFormats.map(
            (format) => [format.toUpperCase(), true] as const,
          ),
        ]
      : [],
  );

  function megabytes(bytes: number): string {
    const megabytes = Math.round(bytes / (1024 * 1024));
    return megabytes >= 1024 ? `${Math.round(megabytes / 102.4) / 10} GB` : `${megabytes} MB`;
  }
</script>

<section class="status-panel">
  <div class="status-headline">
    <span class="status-badge" class:down={!reachable}><Icon name="server" /></span>
    <div>
      <h2>Server</h2>
      <p class="dim">
        {reachable ? 'Answering requests from this device.' : 'Not answering. Check that it is running and on the same network.'}
      </p>
    </div>
    <span class="status-state">
      <span class="dot" class:up={reachable} class:down={!reachable}></span>
      {reachable ? 'Reachable' : 'Unreachable'}
    </span>
  </div>
  {#if capabilities}
    <dl class="status-facts">
      <div><dt>Protocol</dt><dd>{capabilities.protocol.major}.{capabilities.protocol.minor}</dd></div>
      <div><dt>API path</dt><dd><code>{capabilities.protocol.path}</code></dd></div>
      <div><dt>Largest upload</dt><dd>{megabytes(capabilities.limits.maxUploadBytes)}</dd></div>
    </dl>
    <ul class="status-features" aria-label="Features">
      {#each features as [name, on] (name)}
        <li class:on><Icon name={on ? 'check' : 'minus'} />{name}{#if !on} <span class="dim">off</span>{/if}</li>
      {/each}
    </ul>
    {#if !capabilities.features.webdav}
      <p class="dim">
        WebDAV is off because the server was started without it. Start it with
        <code>--webdav</code>, or reinstall the background service with
        <code>ecs service install --webdav</code>, to browse the library from Finder or a file manager.
      </p>
    {/if}
  {:else}
    <p class="dim">Waiting for the server to answer.</p>
  {/if}
</section>
