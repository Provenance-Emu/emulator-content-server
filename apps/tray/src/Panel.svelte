<script lang="ts">
  import Status from '@ecs/web/Status.svelte';
  import Access from './Access.svelte';
  import { canStart, canStop, type ServiceControl, serviceSummary } from './lib/service';
  import { DEFAULT_ORIGIN, type ServerWatch } from './lib/watch.svelte';

  let {
    watch,
    service,
    trayFailure,
    canOpen,
    openBrowser,
  }: {
    watch: ServerWatch;
    service: ServiceControl;
    trayFailure: string | null;
    canOpen: () => void;
    openBrowser: () => void;
  } = $props();

  let typed = $state('');
  const desk = $derived(watch.desk);
  let failure = $state<string | null>(null);
  $effect(() => { typed = watch.origin; });
</script>

<main>
  <div class="row">
    <div>
      <h1>Content Server</h1>
      <p class="dim">
        {watch.checkedAt ? `Checked ${watch.checkedAt}` : 'Checking'}
      </p>
    </div>
    <button type="button" onclick={canOpen}>Open interface</button>
    <button type="button" disabled={!watch.origin} onclick={openBrowser}>Open in browser</button>
  </div>

  <!-- The same component the web interface renders, so the two cannot drift. -->
  <Status capabilities={watch.capabilities} reachable={watch.reachable !== false} />

  {#if trayFailure}
    <p class="problem">The menu bar item could not be created: {trayFailure}</p>
  {/if}

  <section>
    <h2>Server</h2>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        try { watch.watching(typed); failure = null; }
        catch (error) { failure = error instanceof Error ? error.message : String(error); }
      }}
    >
      <label>
        Address
        <input bind:value={typed} size="24" placeholder={DEFAULT_ORIGIN} required />
      </label>
      <button type="submit">Watch</button>
    </form>
  </section>

  {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
  <section>
    <h2>Local login service</h2>
    <p aria-live="polite">{serviceSummary($service)}</p>
    <p class="dim">Controls the service registered for your user on this computer.</p>
    {#if $service.native}
      {#if $service.state === 'absent'}
        <p>Install it first using <code>ecs service install --data /path/to/library</code>.</p>
      {/if}
      <div class="service-actions">
        <button type="button" disabled={!canStart($service)} onclick={() => void service.start()}>
          Start service
        </button>
        <button type="button" disabled={!canStop($service)} onclick={() => void service.stop()}>
          Stop service
        </button>
        <button type="button" disabled={$service.busy} onclick={() => void service.check()}>
          Refresh service status
        </button>
      </div>
      {#if $service.failure}
        <p class="problem" role="alert">{$service.failure}</p>
      {/if}
    {/if}
  </section>

  {#if desk}{#key watch.context?.key}<Access {desk} origin={watch.origin} />{/key}{/if}
</main>

<style>
  .service-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
