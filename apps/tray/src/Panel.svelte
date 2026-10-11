<script lang="ts">
  import Status from '@ecs/web/Status.svelte';
  import { DEFAULT_ORIGIN, type ServerWatch } from './lib/watch.svelte';

  let {
    watch,
    trayFailure,
    canOpen,
  }: {
    watch: ServerWatch;
    trayFailure: string | null;
    canOpen: (url: string) => void;
  } = $props();

  let typed = $state(watch.origin);
</script>

<main>
  <div class="row">
    <div>
      <h1>Content Server</h1>
      <p class="dim">
        {watch.checkedAt ? `Checked ${watch.checkedAt}` : 'Checking'}
      </p>
    </div>
    <button type="button" onclick={() => canOpen(watch.interfaceUrl)}>Open interface</button>
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
        void watch.watching(typed);
      }}
    >
      <label>
        Address
        <input bind:value={typed} size="24" placeholder={DEFAULT_ORIGIN} required />
      </label>
      <button type="submit">Watch</button>
    </form>
    <p class="dim">
      This window holds no password and reads no folder. It asks the server how it is doing.
    </p>
  </section>
</main>
