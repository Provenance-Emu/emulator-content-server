<script lang="ts">
  import type { ContentClient, GuestGrant, GuestGrantCreated, Library } from '@ecs/client';
  import { explain } from './lib/problems';

  let { client, onchange }: { client: ContentClient; onchange?: () => void } = $props();

  let libraries = $state<Library[]>([]);
  let grants = $state<GuestGrant[]>([]);
  let libraryId = $state('');
  let itemId = $state('');
  let allowWrite = $state(false);
  let allowRestricted = $state(false);
  let lifetime = $state('86400');
  /** Tokens created during this visit. A reload drops them; they are never stored. */
  let issued = $state<GuestGrantCreated[]>([]);
  let working = $state(false);
  let failure = $state<string | null>(null);
  let copied = $state<string | null>(null);

  async function load(): Promise<void> {
    try {
      const [libraryPage, grantPage] = await Promise.all([
        client.libraries(),
        client.guestGrants(100),
      ]);
      libraries = libraryPage.items;
      grants = grantPage.items;
      if (!libraryId) libraryId = libraries[0]?.id ?? '';
    } catch (error) {
      failure = explain(error);
    }
  }

  function capabilities(): string[] {
    const chosen = ['read'];
    if (allowWrite) chosen.push('write');
    if (allowRestricted) chosen.push('share_restricted');
    return chosen;
  }

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    working = true;
    failure = null;
    copied = null;
    try {
      const created = await client.createGuestGrant({
        libraryId,
        itemId: itemId.trim() === '' ? null : itemId.trim(),
        capabilities: capabilities(),
        expiresInSeconds: Number(lifetime),
      });
      issued = [created, ...issued];
      itemId = '';
      await load();
      onchange?.();
    } catch (error) {
      failure = explain(error);
    } finally {
      working = false;
    }
  }

  async function revoke(id: string): Promise<void> {
    failure = null;
    try {
      await client.revokeGuestGrant(id);
      await load();
      onchange?.();
    } catch (error) {
      failure = explain(error);
    }
  }

  async function copy(token: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(token);
      copied = token;
    } catch {
      copied = null;
      failure = 'Select the token and copy it. This page will not show it again after a reload.';
    }
  }

  function libraryName(id: string): string {
    return libraries.find((library) => library.id === id)?.name ?? id;
  }

  function capabilityLabel(capability: string): string {
    if (capability === 'share_restricted') return 'BIOS';
    if (capability === 'write') return 'Write';
    return 'Read';
  }

  function grantState(grant: GuestGrant): string {
    if (grant.revokedAt) return 'Revoked';
    if (Date.parse(grant.expiresAt) <= Date.now()) return 'Expired';
    return 'Active';
  }

  function when(value: string): string {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
  }

  void load();
</script>

<section>
  <h2>Guest grants</h2>
  <p class="dim">
    A grant is a token for one library. It is shown once, here, and is not kept on this device.
  </p>
  {#if grants.length === 0}
    <p class="dim">No guest grants yet.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Library</th><th>Scope</th><th>Expires</th><th>State</th><th></th></tr>
      </thead>
      <tbody>
        {#each grants as grant (grant.id)}
          <tr>
            <td>
              {libraryName(grant.libraryId)}
              {#if grant.itemId}
                <span class="dim path">{grant.itemId}</span>
              {/if}
            </td>
            <td>{grant.capabilities.map(capabilityLabel).join(', ')}</td>
            <td>{when(grant.expiresAt)}</td>
            <td>{grantState(grant)}</td>
            <td>
              {#if !grant.revokedAt}
                <button type="button" onclick={() => revoke(grant.id)}>Revoke</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if issued.length > 0}
    <div class="once">
      <p>Copy each token now. A reload clears this list, and the server will not send it again.</p>
      {#each issued as grant (grant.id)}
        <p class="token">
          <code class="path">{grant.token}</code>
          <button type="button" onclick={() => copy(grant.token)}>
            {copied === grant.token ? 'Copied' : 'Copy'}
          </button>
        </p>
        <p class="dim">Expires {when(grant.expiresAt)}</p>
      {/each}
    </div>
  {/if}

  <form onsubmit={create}>
    <label>
      Library
      <select bind:value={libraryId} required>
        {#each libraries as library (library.id)}
          <option value={library.id}>{library.name}</option>
        {/each}
      </select>
    </label>
    <label>
      Item
      <input bind:value={itemId} placeholder="Whole library" size="22" />
    </label>
    <label>
      Lifetime
      <select bind:value={lifetime}>
        <option value="3600">1 hour</option>
        <option value="86400">1 day</option>
        <option value="604800">7 days</option>
        <option value="2592000">30 days</option>
      </select>
    </label>
    <label class="check">
      <input type="checkbox" bind:checked={allowWrite} />
      Allow uploads
    </label>
    <label class="check">
      <input type="checkbox" bind:checked={allowRestricted} />
      Include BIOS and system files
    </label>
    <button type="submit" disabled={working || libraryId === ''}>Create grant</button>
  </form>
  {#if failure}
    <p class="problem">{failure}</p>
  {/if}
</section>
