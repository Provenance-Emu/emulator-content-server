<script lang="ts">
  import type { ContentClient, SessionResponse } from '@ecs/client';
  import { explain } from './lib/problems';

  let {
    client,
    onsignin,
    setup = false,
  }: {
    client: ContentClient;
    onsignin: (session: SessionResponse) => void;
    /** True when the server has no owner yet and is asking for its bootstrap token. */
    setup?: boolean;
  } = $props();

  let token = $state('');
  let username = $state('');
  let password = $state('');
  let working = $state(false);
  let failure = $state<string | null>(null);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    working = true;
    failure = null;
    try {
      const session = setup
        ? await client.bootstrap(token, username, password)
        : await client.login(username, password);
      password = '';
      token = '';
      onsignin(session);
    } catch (error) {
      failure = explain(error);
    } finally {
      working = false;
    }
  }
</script>

<section>
  <h2>{setup ? 'Create the owner' : 'Sign in'}</h2>
  {#if setup}
    <p class="dim">
      The token was printed when the server started and saved as bootstrap.token in the data
      directory.
    </p>
  {/if}
  <form onsubmit={submit}>
    {#if setup}
      <label>
        Bootstrap token
        <input bind:value={token} autocomplete="off" required />
      </label>
    {/if}
    <label>
      Username
      <input bind:value={username} autocomplete="username" required />
    </label>
    <label>
      Password
      <input
        type="password"
        bind:value={password}
        autocomplete={setup ? 'new-password' : 'current-password'}
        required
      />
    </label>
    <button type="submit" disabled={working}>
      {working ? 'Working' : setup ? 'Create owner' : 'Sign in'}
    </button>
  </form>
  {#if !setup}
    <p class="dim">This browser stays signed in until the session expires or you sign out.</p>
  {/if}
  {#if failure}
    <p class="problem">{failure}</p>
  {/if}
</section>
