<script lang="ts">
  import { type Capabilities, ContentClient, type ContentRoot } from '@ecs/client';
  import Libraries from './Libraries.svelte';
  import Login from './Login.svelte';
  import { explain, isForbidden } from './lib/problems';
  import Roots from './Roots.svelte';
  import Status from './Status.svelte';

  // Same origin as the API, which is the whole reason the assets are mounted
  // under /ui instead of being served from somewhere else.
  const client = new ContentClient(window.location.origin);

  let capabilities = $state<Capabilities | null>(null);
  let reachable = $state(true);
  let signedIn = $state(false);
  /** Null until the owner-only call has been tried, so nothing flickers. */
  let roots = $state<ContentRoot[] | null>(null);
  let failure = $state<string | null>(null);

  async function poll(): Promise<void> {
    try {
      capabilities = await client.capabilities();
      reachable = true;
    } catch (error) {
      reachable = false;
      failure = explain(error);
    }
  }

  async function afterSignIn(): Promise<void> {
    signedIn = true;
    failure = null;
    // Owner-only panels are absent rather than disabled, and the server's own
    // answer decides which, so the page cannot disagree with the API.
    try {
      roots = (await client.roots()).items;
    } catch (error) {
      if (!isForbidden(error)) failure = explain(error);
      roots = null;
    }
  }

  async function signOut(): Promise<void> {
    await client.logout().catch(() => undefined);
    signedIn = false;
    roots = null;
  }

  void poll();
  setInterval(() => void poll(), 15_000);
</script>

<main>
  <div class="row">
    <div>
      <h1>Emulator Content Server</h1>
      <p class="dim">Libraries, folders, and status for this machine.</p>
    </div>
    {#if signedIn}
      <button type="button" onclick={signOut}>Sign out</button>
    {/if}
  </div>

  <Status {capabilities} {reachable} />

  {#if signedIn}
    <Libraries {client} />
    {#if roots}
      <Roots {client} {roots} />
    {/if}
  {:else}
    <Login {client} onsignin={afterSignIn} />
  {/if}

  {#if failure && !signedIn}
    <p class="problem">{failure}</p>
  {/if}
</main>
