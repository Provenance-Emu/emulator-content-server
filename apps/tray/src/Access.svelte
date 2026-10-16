<script lang="ts">
  import type { AccessDesk } from './lib/access.svelte';

  let { desk, origin }: { desk: AccessDesk; origin: string } = $props();

  let mode = $state('lan');
  let subnets = $state('');
  let loadedFor = $state<string | null>(null);
  let setupToken = $state('');
  let setupUser = $state('');
  let setupPassword = $state('');
  let username = $state('');
  let password = $state('');
  let accountUser = $state('');
  let accountPassword = $state('');
  let accountLibrary = $state('');
  let accountRole = $state('editor');
  let passwords = $state<Record<string, string>>({});
  let guestLibrary = $state('');
  let guestWrite = $state(false);
  let guestDays = $state(7);

  const manages = $derived(desk.policy?.manages === true || desk.session !== null);

  $effect(() => {
    const policy = desk.policy;
    const current = origin;
    if (!policy || loadedFor === current) return;
    mode = policy.mode;
    subnets = policy.subnets.join('\n');
    loadedFor = current;
  });

  $effect(() => {
    const first = desk.libraries[0]?.id;
    if (!accountLibrary && first) accountLibrary = first;
    if (!guestLibrary && first) guestLibrary = first;
  });

  async function copyGrant(): Promise<void> {
    if (!desk.issuedGrant) return;
    await navigator.clipboard.writeText(desk.issuedGrant).catch(() => undefined);
  }
</script>

<section>
  <h2>Access</h2>

  {#if desk.bootstrapped === false}
    <p class="dim">
      This server has no owner yet. The token was printed when it started and saved as
      bootstrap.token in the data directory.
    </p>
    <form
      class="stack"
      onsubmit={(event) => {
        event.preventDefault();
        const token = setupToken;
        const name = setupUser;
        const secret = setupPassword;
        setupPassword = '';
        void desk.bootstrap(token, name, secret).then((ok) => {
          if (!ok) return;
          setupToken = '';
          setupUser = '';
        });
      }}
    >
      <label>
        Bootstrap token
        <input bind:value={setupToken} autocomplete="off" required />
      </label>
      <label>
        Owner username
        <input bind:value={setupUser} autocomplete="username" required />
      </label>
      <label>
        Password
        <input type="password" bind:value={setupPassword} autocomplete="new-password" required />
      </label>
      <button type="submit" disabled={desk.working}>Create owner</button>
    </form>
  {:else}
    {#if desk.policy && !desk.policy.applies}
      <p class="dim">
        This server was started for the public internet, so every device needs a login.
      </p>
    {:else if desk.policy?.mode === 'token'}
      <p class="dim">Every device needs a username and password.</p>
    {:else if desk.policy?.mode === 'subnets'}
      <p class="dim">
        Only this Mac and the networks you list can sync without a password. This Mac can edit
        accounts.
      </p>
    {:else}
      <p class="dim">
        Devices on this network can sync without a password. This Mac can add accounts and guest
        links. Other networks need a login unless you list them.
      </p>
    {/if}

    {#if desk.bootstrapped && !desk.policy?.manages && !desk.session}
      <form
        class="stack"
        onsubmit={(event) => {
          event.preventDefault();
          const name = username;
          const secret = password;
          password = '';
          void desk.signIn(name, secret);
        }}
      >
        <label>
          Username
          <input bind:value={username} autocomplete="username" required />
        </label>
        <label>
          Password
          <input type="password" bind:value={password} autocomplete="current-password" required />
        </label>
        <button type="submit" disabled={desk.working}>Sign in</button>
      </form>
    {/if}

    {#if desk.session}
      <p class="row">
        <span class="dim">Signed in on this menu bar.</span>
        <button type="button" onclick={() => void desk.signOut()}>Sign out</button>
      </p>
    {/if}

    <form
      class="stack"
      onsubmit={(event) => {
        event.preventDefault();
        void desk.saveAccess(mode, subnets);
      }}
    >
      <label>
        Who needs a login
        <select bind:value={mode}>
          <option value="lan">Local network</option>
          <option value="subnets">Only these networks</option>
          <option value="token">Everyone</option>
        </select>
      </label>
      {#if mode === 'subnets'}
        <label>
          Networks, one per line
          <textarea bind:value={subnets} placeholder="192.168.1.0/24"></textarea>
        </label>
      {/if}
      <button type="submit" disabled={desk.working || !manages}>Save access</button>
    </form>

    {#if manages}
      <h3>Accounts</h3>
      {#if desk.accounts.length === 0}
        <p class="dim">No accounts yet.</p>
      {:else}
        <ul class="people">
          {#each desk.accounts as account (account.id)}
            <li>
              <span>{account.username}{account.isOwner ? ' · owner' : ''}</span>
              <form
                onsubmit={(event) => {
                  event.preventDefault();
                  const secret = passwords[account.id] ?? '';
                  passwords = { ...passwords, [account.id]: '' };
                  void desk.changePassword(account.id, secret);
                }}
              >
                <input
                  type="password"
                  placeholder="New password"
                  autocomplete="new-password"
                  value={passwords[account.id] ?? ''}
                  oninput={(event) => {
                    passwords = { ...passwords, [account.id]: event.currentTarget.value };
                  }}
                />
                <button type="submit" disabled={desk.working}>Set</button>
              </form>
            </li>
          {/each}
        </ul>
      {/if}
      <form
        class="stack"
        onsubmit={(event) => {
          event.preventDefault();
          const name = accountUser;
          const secret = accountPassword;
          accountPassword = '';
          void desk.addUser(name, secret, accountLibrary, accountRole).then((ok) => {
            if (ok) accountUser = '';
          });
        }}
      >
        <label>
          New username
          <input bind:value={accountUser} autocomplete="off" required />
        </label>
        <label>
          Password
          <input
            type="password"
            bind:value={accountPassword}
            autocomplete="new-password"
            required
          />
        </label>
        {#if desk.libraries.length > 0}
          <label>
            Library
            <select bind:value={accountLibrary}>
              {#each desk.libraries as library (library.id)}
                <option value={library.id}>{library.name}</option>
              {/each}
            </select>
          </label>
          <label>
            Role
            <select bind:value={accountRole}>
              <option value="reader">Reader</option>
              <option value="editor">Editor</option>
            </select>
          </label>
        {/if}
        <button type="submit" disabled={desk.working}>Add account</button>
      </form>

      <h3>Guest links</h3>
      <p class="dim">
        A guest link is for someone off this network. It expires, and it can be revoked.
      </p>
      {#if desk.issuedGrant}
        <p class="dim">Copy this token now. It will not be shown again.</p>
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void copyGrant();
          }}
        >
          <input readonly value={desk.issuedGrant} size="28" />
          <button type="submit">Copy</button>
          <button type="button" onclick={() => (desk.issuedGrant = null)}>Hide</button>
        </form>
      {/if}
      {#if desk.grants.length > 0}
        <ul class="people">
          {#each desk.grants as grant (grant.id)}
            <li>
              <span>
                {grant.capabilities.join(', ')} · until {grant.expiresAt.slice(0, 10)}
              </span>
              <button
                type="button"
                disabled={desk.working}
                onclick={() => void desk.revokeGuest(grant.id)}
              >
                Revoke
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if desk.libraries.length > 0}
        <form
          class="stack"
          onsubmit={(event) => {
            event.preventDefault();
            void desk.addGuest(guestLibrary, guestWrite, guestDays);
          }}
        >
          <label>
            Library
            <select bind:value={guestLibrary}>
              {#each desk.libraries as library (library.id)}
                <option value={library.id}>{library.name}</option>
              {/each}
            </select>
          </label>
          <label>
            Days
            <input type="number" min="1" max="30" bind:value={guestDays} />
          </label>
          <label class="check">
            <input type="checkbox" bind:checked={guestWrite} />
            Allow uploads
          </label>
          <button type="submit" disabled={desk.working}>Create guest link</button>
        </form>
      {/if}
    {/if}
  {/if}

  {#if desk.failure}
    <p class="problem">{desk.failure}</p>
  {/if}
</section>

<style>
  .people {
    list-style: none;
    margin: 0 0 0.75rem;
    padding: 0;
  }

  .people li {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: center;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--line);
  }

  .check {
    flex-direction: row;
    align-items: center;
  }
</style>
