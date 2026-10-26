<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { ContentError, type ContentClient, type WebDavCredential, type WebDavCredentialCreated } from '@ecs/client';
  import { explain } from './lib/problems';
  let { client, origin, onrejected }: { client: ContentClient; origin: string; onrejected: (status: 401 | 403) => void } = $props();
  let credentials = $state<WebDavCredential[]>([]);
  let issued = $state<WebDavCredentialCreated | null>(null);
  let name = $state('');
  let lifetime = $state('7776000');
  let working = $state(false);
  let loaded = $state(false);
  let failure = $state<string | null>(null);
  let disposed = false;
  onDestroy(() => { disposed = true; issued = null; credentials = []; });
  function reject(error: unknown) {
    if (disposed) return;
    failure = explain(error);
    if (error instanceof ContentError && (error.status === 401 || error.status === 403)) {
      credentials = []; issued = null; loaded = false;
      if (error.status === 401) onrejected(401);
    }
  }
  async function load() {
    working = true; failure = null;
    try {
      const result = await client.webdavCredentials();
      if (!disposed) { credentials = result.items; loaded = true; }
    } catch (error) { reject(error); }
    finally { if (!disposed) working = false; }
  }
  async function create() {
    if (working) return;
    working = true; failure = null;
    try {
      const result = await client.createWebdavCredential({ name: name.trim(), expiresInSeconds: Number(lifetime) });
      if (!disposed) { issued = result; credentials = [...credentials, result.credential]; name = ''; }
    } catch (error) { reject(error); }
    finally { if (!disposed) working = false; }
  }
  async function revoke(id: string) {
    if (working) return;
    working = true; failure = null;
    try {
      await client.revokeWebdavCredential(id);
      if (!disposed) {
        credentials = credentials.map(credential => credential.id === id ? { ...credential, revokedAt: new Date().toISOString() } : credential);
        if (issued?.credential.id === id) issued = null;
      }
    } catch (error) { reject(error); }
    finally { if (!disposed) working = false; }
  }
  onMount(() => { void load(); });
</script>

<h1>WebDAV</h1>
<p>Browse and download your libraries in Finder or another WebDAV client.</p>
<label>Server address<input readonly value={new URL('/dav/', origin).href} /></label>
<p class="dim">App credentials belong to your signed-in account and follow its library permissions. Sign in with a username and password to manage them.</p>
{#if loaded}
  {#if credentials.length}<div class="table-scroll"><table>
    <thead><tr><th>Name</th><th>Expires</th><th>State</th><th>Action</th></tr></thead>
    <tbody>{#each credentials as credential (credential.id)}<tr>
      <td>{credential.name}</td><td>{new Date(credential.expiresAt).toLocaleDateString()}</td>
      <td>{credential.revokedAt ? 'Revoked' : Date.parse(credential.expiresAt) <= Date.now() ? 'Expired' : 'Active'}</td>
      <td>{#if !credential.revokedAt}<button type="button" disabled={working} aria-label={`Revoke ${credential.name}`} onclick={() => void revoke(credential.id)}>Revoke</button>{/if}</td>
    </tr>{/each}</tbody>
  </table></div>{:else}<p class="dim">No app credentials yet.</p>{/if}
  {#if issued}<section aria-label="New WebDAV credential">
    <p>Copy this password now. It will not be shown again after you leave this page.</p>
    <label>WebDAV username<input readonly value={issued.credential.username} autocomplete="off" /></label>
    <label>WebDAV password<input readonly value={issued.password} autocomplete="off" /></label>
    <button type="button" onclick={() => issued = null}>Hide credential</button>
  </section>{/if}
  <form onsubmit={(event) => { event.preventDefault(); void create(); }}>
    <label>Credential name<input bind:value={name} required maxlength="80" disabled={working} /></label>
    <label>Credential lifetime<select bind:value={lifetime} disabled={working}><option value="604800">7 days</option><option value="2592000">30 days</option><option value="7776000">90 days</option><option value="31536000">1 year</option></select></label>
    <button type="submit" disabled={working}>Create app credential</button>
  </form>
{:else if working}<p role="status">Loading app credentials…</p>{:else}<button type="button" onclick={() => void load()}>Retry app credentials</button>{/if}
{#if failure}<p class="problem" role="alert">{failure}</p>{/if}
