<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { ContentError, type AccessPolicy, type ContentClient, type Library, type User } from '@ecs/client';
  import { explain } from './lib/problems';

  let { client, libraries, onrejected, onchange }: {
    client: ContentClient; libraries: Library[];
    onrejected: (status: 401 | 403) => void; onchange: () => void | Promise<void>;
  } = $props();
  let users = $state<User[]>([]);
  let policy = $state<AccessPolicy | null>(null);
  let mode = $state('lan');
  let subnets = $state('');
  let username = $state('');
  let password = $state('');
  let userId = $state('');
  let libraryId = $state('');
  let role = $state('reader');
  let replacement = $state('');
  let working = $state(false);
  let loaded = $state(false);
  let failure = $state<string | null>(null);
  let message = $state<string | null>(null);
  let disposed = false;

  onDestroy(() => { disposed = true; password = ''; replacement = ''; });
  function reject(error: unknown) {
    if (disposed) return;
    failure = explain(error);
    if (error instanceof ContentError && (error.status === 401 || error.status === 403)) {
      users = []; policy = null; loaded = false; password = ''; replacement = '';
      onrejected(error.status);
    }
  }
  async function load() {
    working = true; failure = null;
    try {
      const [accounts, access] = await Promise.all([client.users(), client.access()]);
      if (disposed) return;
      users = accounts.items; policy = access; mode = access.mode; subnets = access.subnets.join('\n');
      userId ||= users.find(user => !user.isOwner)?.id ?? users[0]?.id ?? '';
      libraryId ||= libraries[0]?.id ?? '';
      loaded = true;
    } catch (error) { reject(error); }
    finally { if (!disposed) working = false; }
  }
  async function act(operation: () => Promise<unknown>, success: string) {
    if (working || disposed) return;
    working = true; failure = null; message = null;
    try {
      await operation();
      if (disposed) return;
      message = success;
      await onchange();
    } catch (error) { reject(error); }
    finally { if (!disposed) working = false; }
  }
  async function addAccount() {
    const secret = password; password = '';
    await act(async () => {
      const user = await client.createUser({ username: username.trim(), password: secret });
      if (disposed) return;
      users = [...users, user]; userId = user.id; username = '';
    }, 'Account created. Choose its library access below.');
  }
  function changePassword() {
    const secret = replacement; replacement = '';
    return act(() => client.setPassword(userId, secret), 'Password changed. Other sessions for this account were revoked.');
  }
  onMount(() => { void load(); });
</script>

<section aria-label="Accounts and network access">
  {#if !loaded}
    {#if working}<p role="status">Loading access settings…</p>{:else}<button type="button" onclick={() => void load()}>Retry access settings</button>{/if}
  {:else}
    <h2>Network access</h2>
    <p class="dim">Trusted devices can use libraries without signing in. Choose Everyone to require credentials on every connection.</p>
    {#if policy && !policy.applies}<p class="dim">This server was started with public access: credentials are required regardless of this setting.</p>{/if}
    <form onsubmit={(event) => { event.preventDefault(); void act(async () => {
      const next = await client.setAccess({ mode, subnets: mode === 'subnets' ? subnets.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [] });
      if (!disposed) policy = next;
    }, 'Network access saved.'); }}>
      <fieldset disabled={working}>
        <label for="network-mode">Who needs a login</label><select id="network-mode" bind:value={mode}><option value="lan">Outside the local network</option><option value="subnets">Outside these networks</option><option value="token">Everyone</option></select>
        {#if mode === 'subnets'}<label>Trusted networks, one per line<textarea bind:value={subnets} placeholder="192.168.1.0/24"></textarea></label>{/if}
        <button type="submit">Save network access</button>
      </fieldset>
    </form>

    <h2>Accounts</h2>
    <ul>{#each users as user (user.id)}<li>{user.username}{user.isOwner ? ' · owner' : ''}</li>{/each}</ul>
    <form onsubmit={(event) => { event.preventDefault(); void addAccount(); }}>
      <fieldset disabled={working}>
        <label>New username<input bind:value={username} required autocomplete="off" /></label>
        <label>New account password<input type="password" bind:value={password} required autocomplete="new-password" /></label>
        <button type="submit">Add account</button>
      </fieldset>
    </form>
    <label for="account-user">Account</label><select id="account-user" bind:value={userId} disabled={working}>{#each users as user (user.id)}<option value={user.id}>{user.username}</option>{/each}</select>
    <form onsubmit={(event) => { event.preventDefault(); void changePassword(); }}>
      <fieldset disabled={working || !userId}>
        <label>Replacement password<input type="password" bind:value={replacement} required autocomplete="new-password" /></label>
        <button type="submit">Change password</button>
      </fieldset>
    </form>
    <h3>Library access</h3>
    <p class="dim">Readers can browse and download. Editors can also upload. Server owners retain access to every library.</p>
    {#if libraries.length}
      <form onsubmit={(event) => { event.preventDefault(); void act(() => client.assignMember(libraryId, userId, role), 'Library access saved.'); }}>
        <fieldset disabled={working || !userId || users.some(user => user.id === userId && user.isOwner)}>
          <label for="account-library">Account library</label><select id="account-library" bind:value={libraryId}>{#each libraries as library (library.id)}<option value={library.id}>{library.name}</option>{/each}</select>
          <label for="account-role">Library role</label><select id="account-role" bind:value={role}><option value="reader">Reader</option><option value="editor">Editor</option></select>
          <button type="submit">Save library access</button>
          <button type="button" onclick={() => void act(() => client.removeMember(libraryId, userId), 'Library access removed.')}>Remove library access</button>
        </fieldset>
      </form>
    {:else}<p class="dim">Create a library to assign access.</p>{/if}
  {/if}
  {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
</section>

<style>fieldset { border: 0; padding: 0; margin: 0; min-width: 0; } section { margin-bottom: 2rem; }</style>
