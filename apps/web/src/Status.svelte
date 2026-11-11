<script lang="ts">
  import type { Capabilities } from '@ecs/client';

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
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }
</script>

<section>
  <div class="row">
    <h2>Server</h2>
    <span class="dim">
      <span class="dot" class:up={reachable} class:down={!reachable}></span>
      {reachable ? 'Reachable' : 'Unreachable'}
    </span>
  </div>
  {#if capabilities}
    <p class="dim">
      Protocol {capabilities.protocol.major}.{capabilities.protocol.minor} at
      <code>{capabilities.protocol.path}</code>, uploads up to
      {megabytes(capabilities.limits.maxUploadBytes)}.
    </p>
    <ul class="tags">
      {#each features as [name, on] (name)}
        <li class:on>{name}{#if !on} <span class="dim">off</span>{/if}</li>
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
