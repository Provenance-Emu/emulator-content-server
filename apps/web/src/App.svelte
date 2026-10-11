<script lang="ts">
  import {
    type Capabilities,
    ContentClient,
    type ContentRoot,
    type SessionResponse,
  } from '@ecs/client';
  import Libraries from './Libraries.svelte';
  import { explain, isForbidden, isUnauthorized } from './lib/problems';
  import { clearSession, loadSession, saveSession } from './lib/session';
  import Login from './Login.svelte';
  import Roots from './Roots.svelte';
  import Status from './Status.svelte';

  // Same origin as the API, which is the whole reason the assets are mounted
  // under /ui instead of being served from somewhere else.
  const client = new ContentClient(window.location.origin);

  let capabilities = $state<Capabilities | null>(null);
  let reachable = $state(true);
  let signedIn = $state(false);
  /** False until a stored token has been tried, so no login form flashes. */
  let settled = $state(false);
  /** Null when this account is not the owner, which hides the owner panels. */
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

  /**
   * Decides what this token can do by asking the server. Owner-only panels are
   * absent rather than disabled, and the server's own answer decides which, so
   * the page cannot disagree with the API.
   */
  async function adopt(): Promise<void> {
    failure = null;
    try {
      roots = (await client.roots()).items;
      signedIn = true;
    } catch (error) {
      roots = null;
      if (isUnauthorized(error)) {
        forget();
        return;
      }
      // A 403 only means this account is not the owner, and anything else is
      // worth saying out loud while still letting the rest of the page work.
      signedIn = true;
      if (!isForbidden(error)) failure = explain(error);
    }
  }

  function remember(session: SessionResponse): void {
    saveSession({ token: session.token, expiresAt: session.expiresAt });
    void adopt();
  }

  function forget(): void {
    clearSession();
    client.setToken(undefined);
    signedIn = false;
    roots = null;
  }

  async function signOut(): Promise<void> {
    await client.logout().catch(() => undefined);
    forget();
  }

  async function restore(): Promise<void> {
    const stored = loadSession();
    // A stored token may have been revoked or the server may have been rebuilt,
    // so it has to be tried before the page claims to be signed in.
    if (stored) {
      client.setToken(stored.token);
      await adopt();
    }
    settled = true;
  }

  void poll();
  void restore();
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
  {:else if settled}
    <Login {client} onsignin={remember} />
  {/if}

  {#if failure && !signedIn}
    <p class="problem">{failure}</p>
  {/if}
</main>
