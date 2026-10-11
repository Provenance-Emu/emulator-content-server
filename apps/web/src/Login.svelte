<script lang="ts">
  import type { ContentClient, SessionResponse } from '@ecs/client';
  import { explain } from './lib/problems';

  let {
    client,
    onsignin,
  }: { client: ContentClient; onsignin: (session: SessionResponse) => void } = $props();

  let username = $state('');
  let password = $state('');
  let working = $state(false);
  let failure = $state<string | null>(null);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    working = true;
    failure = null;
    try {
      const session = await client.login(username, password);
      password = '';
      onsignin(session);
    } catch (error) {
      failure = explain(error);
    } finally {
      working = false;
    }
  }
</script>

<section>
  <h2>Sign in</h2>
  <form onsubmit={submit}>
    <label>
      Username
      <input bind:value={username} autocomplete="username" required />
    </label>
    <label>
      Password
      <input type="password" bind:value={password} autocomplete="current-password" required />
    </label>
    <button type="submit" disabled={working}>{working ? 'Signing in' : 'Sign in'}</button>
  </form>
  <p class="dim">This browser stays signed in until the session expires or you sign out.</p>
  {#if failure}
    <p class="problem">{failure}</p>
  {/if}
</section>
