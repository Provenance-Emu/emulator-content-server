<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { ContentError, type AccessPolicy, type ContentClient, type Library, type LibraryMember, type User } from '@ecs/client';
  import { explain } from './lib/problems';
  import FormField from './components/FormField.svelte';
  import InlineNotice from './components/InlineNotice.svelte';

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
  let members = $state<LibraryMember[]>([]);
  let membershipSelection = $state('');
  let membershipWorking = $state(false);
  let membershipFailure = $state<string | null>(null);
  let membershipGeneration = 0;
  const selectedOwner = $derived(users.some(user => user.id === userId && user.isOwner));
  const membershipCurrent = $derived(membershipSelection === `${libraryId}:${userId}` && !membershipWorking);
  const currentRole = $derived(members.find(member => member.userId === userId)?.role ?? null);
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
  async function loadMembership(selectedLibrary: string, selectedUser: string) {
    const run = ++membershipGeneration;
    membershipWorking = true; membershipFailure = null; membershipSelection = ''; members = [];
    try {
      const result = await client.libraryMembers(selectedLibrary);
      if (disposed || run !== membershipGeneration || libraryId !== selectedLibrary || userId !== selectedUser) return;
      members = result.items;
      role = members.find(member => member.userId === selectedUser)?.role ?? 'reader';
      membershipSelection = `${selectedLibrary}:${selectedUser}`;
    } catch (error) {
      if (disposed || run !== membershipGeneration || libraryId !== selectedLibrary || userId !== selectedUser) return;
      membershipFailure = explain(error);
      if (error instanceof ContentError && (error.status === 401 || error.status === 403)) reject(error);
    } finally { if (!disposed && run === membershipGeneration) membershipWorking = false; }
  }
  async function changeMembership(remove = false) {
    const selectedLibrary = libraryId; const selectedUser = userId; const selectedRole = role;
    if (!membershipCurrent || selectedOwner) return;
    await act(async () => {
      if (remove) await client.removeMember(selectedLibrary, selectedUser);
      else await client.assignMember(selectedLibrary, selectedUser, selectedRole);
      if (!disposed) await loadMembership(selectedLibrary, selectedUser);
    }, remove ? 'Library access removed.' : 'Library access saved.');
  }
  $effect(() => {
    if (loaded && libraryId && userId) void loadMembership(libraryId, userId);
  });
  onMount(() => { void load(); });
</script>

<section aria-label="Accounts and network access">
  {#if !loaded}
    {#if working}<InlineNotice kind="status">Loading access settings…</InlineNotice>{:else}<button type="button" onclick={() => void load()}>Retry access settings</button>{/if}
  {:else}
    <h2>Network access</h2>
    <p class="dim">Trusted devices can use libraries without signing in. Choose Everyone to require credentials on every connection.</p>
    {#if policy && !policy.applies}<p class="dim">This server was started with public access: credentials are required regardless of this setting.</p>{/if}
    <form class="settings-form" onsubmit={(event) => { event.preventDefault(); void act(async () => {
      const next = await client.setAccess({ mode, subnets: mode === 'subnets' ? subnets.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [] });
      if (!disposed) policy = next;
    }, 'Network access saved.'); }}>
      <fieldset disabled={working}>
        <FormField label="Who needs a login" id="network-mode">{#snippet children(attributes)}<select {...attributes} bind:value={mode}><option value="lan">Outside the local network</option><option value="subnets">Outside these networks</option><option value="token">Everyone</option></select>{/snippet}</FormField>
        {#if mode === 'subnets'}<FormField label="Trusted networks, one per line">{#snippet children(attributes)}<textarea {...attributes} bind:value={subnets} placeholder="192.168.1.0/24"></textarea>{/snippet}</FormField>{/if}
        <button type="submit">Save network access</button>
      </fieldset>
    </form>

    <h2>Accounts</h2>
    <ul>{#each users as user (user.id)}<li>{user.username}{user.isOwner ? ' · owner' : ''}</li>{/each}</ul>
    <form class="settings-form" onsubmit={(event) => { event.preventDefault(); void addAccount(); }}>
      <fieldset disabled={working}>
        <div class="settings-fields">
          <FormField label="New username">{#snippet children(attributes)}<input {...attributes} bind:value={username} required autocomplete="off" />{/snippet}</FormField>
          <FormField label="New account password">{#snippet children(attributes)}<input {...attributes} type="password" bind:value={password} required autocomplete="new-password" />{/snippet}</FormField>
        </div>
        <button type="submit">Add account</button>
      </fieldset>
    </form>
    <FormField label="Account" id="account-user" help="Choose the account you want to manage.">{#snippet children(attributes)}<select {...attributes} bind:value={userId} disabled={working}>{#each users as user (user.id)}<option value={user.id}>{user.username}</option>{/each}</select>{/snippet}</FormField>
    <form class="settings-form" onsubmit={(event) => { event.preventDefault(); void changePassword(); }}>
      <fieldset disabled={working || !userId}>
        <FormField label="Replacement password" help="Changing this password signs out the account’s other sessions.">{#snippet children(attributes)}<input {...attributes} type="password" bind:value={replacement} required autocomplete="new-password" />{/snippet}</FormField>
        <button type="submit">Change password</button>
      </fieldset>
    </form>
    <h3>Library access</h3>
    <p class="dim">Readers can browse and download. Editors can also upload. Server owners retain access to every library.</p>
    {#if libraries.length}
      <FormField label="Account library" id="account-library">{#snippet children(attributes)}<select {...attributes} bind:value={libraryId} disabled={working}>{#each libraries as library (library.id)}<option value={library.id}>{library.name}</option>{/each}</select>{/snippet}</FormField>
      {#if selectedOwner}<InlineNotice kind="status">Current access: Server owner · retains access to every library.</InlineNotice>
      {:else if membershipWorking || !membershipCurrent && !membershipFailure}<InlineNotice kind="status">Loading current access…</InlineNotice>
      {:else if membershipFailure}<InlineNotice kind="error">{membershipFailure}</InlineNotice><button type="button" disabled={working} onclick={() => void loadMembership(libraryId, userId)}>Retry library access</button>
      {:else}<InlineNotice kind="status">Current access: {currentRole === 'owner' ? 'Library owner' : currentRole === 'editor' ? 'Editor' : currentRole === 'reader' ? 'Reader' : 'No access'}</InlineNotice>{/if}
      <form class="settings-form" onsubmit={(event) => { event.preventDefault(); void changeMembership(); }}>
        <fieldset disabled={working || !userId || selectedOwner || !membershipCurrent}>
          <FormField label="Library role" id="account-role">{#snippet children(attributes)}<select {...attributes} bind:value={role}>
            {#if currentRole === 'owner'}<option value="owner">Library owner</option>{/if}
            <option value="reader">Reader</option><option value="editor">Editor</option>
          </select>{/snippet}</FormField>
          <div class="actions">
            <button type="submit">Save library access</button>
            <button type="button" disabled={!currentRole} onclick={() => void changeMembership(true)}>Remove library access</button>
          </div>
        </fieldset>
      </form>
    {:else}<InlineNotice>Create a library to assign access.</InlineNotice>{/if}
  {/if}
  {#if failure}<InlineNotice kind="error">{failure}</InlineNotice>{/if}
  {#if message}<InlineNotice kind="status">{message}</InlineNotice>{/if}
</section>

<style>section { margin-bottom: var(--space-8); }</style>
