<script lang="ts">
  import Status from '@ecs/web/Status.svelte';
  import type { Readable } from 'svelte/store';
  import type { DesktopSelection } from './lib/application';
  import Access from './Access.svelte';
  import { canStart, canStop, type ServiceControl, serviceSummary } from './lib/service';
  import { DEFAULT_ORIGIN, type ServerWatch } from './lib/watch.svelte';

  let {
    watch,
    service,
    selection,
    trayFailure,
    cliTools,
    installCliTools,
    canOpen,
    openBrowser,
  }: {
    watch: ServerWatch;
    service: ServiceControl;
    selection: DesktopSelection;
    trayFailure: Readable<string | null>;
    cliTools: Readable<{ busy: boolean; message: string; failure: boolean }>;
    installCliTools?: () => Promise<void>;
    canOpen: () => void;
    openBrowser: () => void;
  } = $props();

  let typed = $state('');
  const profiles = $derived(selection.profiles);
  const desk = $derived(watch.desk);
  let failure = $state<string | null>(null);
  $effect(() => { typed = watch.origin; });
</script>

<main>
  <div class="row">
    <div>
      <h1>Emulation Server</h1>
      <p class="dim">
        {watch.checkedAt ? `Checked ${watch.checkedAt}` : 'Checking'}
      </p>
    </div>
    <button type="button" onclick={canOpen}>Open interface</button>
    <button type="button" disabled={!watch.origin} onclick={openBrowser}>Open in browser</button>
  </div>

  <!-- The same component the web interface renders, so the two cannot drift. -->
  <Status capabilities={watch.capabilities} reachable={watch.reachable !== false} />

  {#if $trayFailure}
    <p class="problem">The menu bar item could not be created: {$trayFailure}</p>
  {/if}

  <section>
    <h2>Servers</h2>
    {#if $profiles.length}
      <ul class="saved-servers">
        {#each $profiles as profile}
          <li>
            <button type="button" aria-pressed={profile.origin === $selection?.origin && profile.profileKey === $selection?.profile.profileKey}
              onclick={() => selection.select(profile)}>{profile.label}</button>
          </li>
        {/each}
      </ul>
    {/if}
    <form
      onsubmit={(event) => {
        event.preventDefault();
        try { watch.watching(typed); failure = null; }
        catch (error) { failure = error instanceof Error ? error.message : String(error); }
      }}
    >
      <label>
        Add a server address
        <input bind:value={typed} size="24" placeholder={DEFAULT_ORIGIN} required />
      </label>
      <button type="submit">Connect</button>
    </form>
  </section>

  {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
  <section>
    <h2>Local service</h2>
    <p aria-live="polite">{serviceSummary($service)}</p>
    {#if $service.state === 'boot-running' || $service.state === 'boot-stopped'}
      <p class="dim">Use launchctl as an administrator to start or stop the boot service.</p>
    {/if}
    {#if $service.native}
      {#if $service.state === 'absent'}
        <p>Open the library window for setup and connection options.</p>
        <button type="button" onclick={canOpen}>Open server setup</button>
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

  {#if installCliTools}
    <section>
      <h2>Command-line tools</h2>
      <p class="dim">Use <code>ecs</code> and <code>ecs-plugins</code> in Terminal.</p>
      <button type="button" disabled={$cliTools.busy} onclick={() => void installCliTools?.()}>Install CLI Tools</button>
      {#if $cliTools.message}
        <p role={$cliTools.failure ? 'alert' : 'status'} class:problem={$cliTools.failure}>{$cliTools.message}</p>
        {#if !$cliTools.busy && !$cliTools.failure}
          <p class="dim">For an open zsh or Bash window, run <code>export PATH="$HOME/.local/bin:$PATH"</code>.</p>
        {/if}
      {/if}
    </section>
  {/if}

  {#if desk}{#key watch.context?.key}<Access {desk} origin={watch.origin} />{/key}{/if}
</main>

<style>
  .saved-servers { display: grid; gap: .5rem; list-style: none; padding: 0; }
  .service-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
