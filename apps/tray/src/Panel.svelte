<script lang="ts">
  import Status from '@ecs/web/Status.svelte';
  import type { Readable } from 'svelte/store';
  import type { DesktopSelection } from './lib/application';
  import Access from './Access.svelte';
  import {
    canRepair,
    canRestart,
    canStart,
    canStop,
    isBootService,
    type ServiceControl,
    serviceSummary,
  } from './lib/service';
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

<main class="status-window compact-controls">
  <header class="status-window-heading">
    <div>
      <h1>Emulation Server</h1>
      <p class="dim">
        {watch.checkedAt ? `Checked ${watch.checkedAt}` : 'Checking'}
      </p>
    </div>
    <div class="actions">
      <button type="button" disabled={!watch.origin} onclick={openBrowser}>Open in browser</button>
      <button type="button" class="primary" onclick={canOpen}>Open interface</button>
    </div>
  </header>

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
    <p class="service-summary" aria-live="polite">
      <span class="dot" class:up={canStop($service)} class:down={!!$service.failure}></span>{serviceSummary($service)}
    </p>
    {#if isBootService($service)}
      <p class="dim">
        This server starts with the computer. You can start, stop and restart it yourself; macOS
        asks for an administrator only if someone else installed it or it was switched off.
      </p>
    {:else if $service.state === 'broken'}
      <p>
        The server build this service starts is no longer installed. Repair registers the service
        again with an installed build and keeps your library and settings.
      </p>
    {:else if $service.state === 'failing'}
      <p>
        The server starts and then stops. Restart tries again now; Repair registers the service
        again with an installed build.
      </p>
    {/if}
    {#if $service.native}
      {#if $service.state === 'absent'}
        <p>Open the library window for setup and connection options.</p>
        <button type="button" onclick={canOpen}>Open server setup</button>
      {/if}
      <div class="service-actions">
        {#if $service.state === 'broken'}
          <button type="button" class="primary" disabled={!canRepair($service)} onclick={() => void service.repair()}>
            Repair service
          </button>
        {:else}
          <button type="button" disabled={!canStart($service)} onclick={() => void service.start()}>
            Start service
          </button>
          <button type="button" disabled={!canRestart($service)} onclick={() => void service.restart()}>
            Restart service
          </button>
        {/if}
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
      {#if $service.state !== 'broken' && canRepair($service)}
        <details class="service-repair">
          <summary>Something not working?</summary>
          <p class="dim">
            Repair registers the login service again with an installed server build. Your library,
            saves and settings stay where they are. The server restarts.
          </p>
          <button type="button" onclick={() => void service.repair()}>Repair service</button>
        </details>
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
  .status-window { max-width: 40rem; padding: var(--space-5) var(--space-5) var(--space-8); }
  .status-window-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .status-window-heading p { margin: 0; font-size: var(--text-small); }
  .saved-servers { display: grid; gap: 2px; list-style: none; margin: 0 0 var(--space-4); padding: 0; }
  .saved-servers button { width: 100%; text-align: left; background: transparent; border-color: transparent; box-shadow: none; }
  .saved-servers button:hover { background: var(--color-hover); }
  .saved-servers button[aria-pressed="true"] { background: var(--color-selected); color: var(--color-selected-text); }
  .status-window form { align-items: end; }
  .status-window form label { flex: 1 1 14rem; }
  .service-summary { display: flex; align-items: center; margin-top: 0; }
  .service-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .service-repair { margin-top: var(--space-3); }
  .service-repair summary { cursor: pointer; font-size: var(--text-small); color: var(--color-text-muted); }
</style>
