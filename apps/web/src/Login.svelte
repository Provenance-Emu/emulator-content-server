<script lang="ts">
  import { ContentClient } from '@ecs/client';
  import { onDestroy } from 'svelte';
  import type { StoredSession } from './lib/session';
  import { explain } from './lib/problems';

  let {
    client,
    origin,
    onsignin,
    setup = false,
  }: {
    client: ContentClient;
    origin: string;
    onsignin: (session: StoredSession) => void;
    /** True when the server has no owner yet and is asking for its bootstrap token. */
    setup?: boolean;
  } = $props();

  let token = $state('');
  let useToken = $state(false);
  let username = $state('');
  let password = $state('');
  let working = $state(false);
  let failure = $state<string | null>(null);
  let disposed = false;
  onDestroy(() => { disposed = true; password = ''; token = ''; });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    working = true;
    failure = null;
    try {
      const pasted = token.trim();
      const authentication = new ContentClient(origin);
      const session = !setup && useToken ? await tokenSession(pasted) : setup
        ? await authentication.bootstrap(token, username, password)
        : await authentication.login(username, password);
      if (disposed) return;
      password = '';
      token = '';
      onsignin(session);
    } catch (error) {
      failure = explain(error);
    } finally {
      working = false;
    }
  }

  async function tokenSession(value: string): Promise<StoredSession> {
    // Validate without mutating the application client or a different login lifetime.
    await new ContentClient(origin, value).libraries();
    return { token: value, expiresAt: new Date(Date.now() + 86400 * 1000).toISOString() };
  }
</script>

<section class="sign-in-panel">
  <h2>{setup ? 'Set up your library' : 'Sign in'}</h2>
  {#if setup}
    <p class="dim">
      Create an account to add games and manage this library. Use the setup code shown when
      Emulation Server first started. It is also saved in the server’s data folder as bootstrap.token.
    </p>
  {:else}
    <p class="sign-in-intro">Sign in to browse your games, download them to an emulator, or play supported games in your browser.</p>
  {/if}
  <form class="stack sign-in-form" onsubmit={submit} aria-busy={working}>
    {#if setup}
      <label>
        Setup code (bootstrap token)
        <input type="password" bind:value={token} autocomplete="off" required disabled={working} />
      </label>
    {/if}
    {#if !setup && useToken}
      <label>Access token<input type="password" bind:value={token} autocomplete="off" required disabled={working} /></label>
      <p class="dim">Paste a guest or device token. This browser remembers it for up to one day; the server still enforces its expiration and permissions.</p>
    {:else}<label>
      Username
      <input bind:value={username} autocomplete="username" required disabled={working} autocapitalize="none" spellcheck="false" />
    </label>
    <label>
      Password
      <input
        type="password"
        bind:value={password}
        autocomplete={setup ? 'new-password' : 'current-password'}
        required
        disabled={working}
      />
    </label>{/if}
    <button type="submit" class="primary" disabled={working}>
      {working ? (setup ? 'Creating your account…' : 'Signing in…') : setup ? 'Create owner' : useToken ? 'Connect with token' : 'Sign in'}
    </button>
  </form>
  {#if !setup}
    <p class="sign-in-help dim">Use the account provided by the person who manages this library. If this is your library, use the account you created during setup.</p>
    <button class="text-button" type="button" disabled={working} onclick={() => { useToken = !useToken; token = ''; password = ''; failure = null; }}>{useToken ? 'Use username and password' : 'Use an access token'}</button>
    <p class="dim">This browser stays signed in until the session expires or you sign out.</p>
  {/if}
  {#if failure}
    <p class="problem" role="alert">{failure}</p>
  {/if}
</section>
