<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { ContentError, type ContentClient, type DeviceToken, type DeviceTokenCreated } from '@ecs/client';
  import { explain } from './lib/problems';
  import FormField from './components/FormField.svelte';
  import InlineNotice from './components/InlineNotice.svelte';

  let { client, onrejected }: { client: ContentClient; onrejected: (status: 401 | 403) => void } = $props();
  let devices = $state<DeviceToken[]>([]);
  let issued = $state<DeviceTokenCreated | null>(null);
  let name = $state('');
  let permission = $state('read');
  let lifetime = $state('7776000');
  let working = $state(false);
  let loaded = $state(false);
  let needsReconciliation = $state(false);
  let failure = $state<string | null>(null);
  let disposed = false;
  onDestroy(() => { disposed = true; issued = null; devices = []; });
  function reject(error: unknown) {
    if (disposed) return;
    failure = explain(error);
    if (error instanceof ContentError && (error.status === 401 || error.status === 403)) {
      issued = null; devices = []; loaded = false; needsReconciliation = false;
      onrejected(error.status);
    }
  }
  async function load() {
    if (working || disposed) return;
    working = true; failure = null;
    try {
      const result = await client.deviceTokens();
      if (!disposed) { devices = result.items; loaded = true; needsReconciliation = false; }
    } catch (error) { reject(error); }
    finally { if (!disposed) working = false; }
  }
  async function create() {
    if (working || disposed || needsReconciliation) return;
    working = true; failure = null;
    let created = false;
    try {
      const result = await client.createDeviceToken({ name: name.trim(), scopes: permission === 'write' ? ['read', 'write'] : ['read'], expiresInSeconds: Number(lifetime) });
      if (disposed) return;
      issued = result; name = ''; created = true; needsReconciliation = true;
      const listing = await client.deviceTokens();
      if (!disposed) { devices = listing.items; needsReconciliation = false; }
    } catch (error) {
      reject(error);
      if (created && !disposed && issued) failure = `Token created, but the device list could not be refreshed. Retry the list before creating another token. ${explain(error)}`;
    }
    finally { if (!disposed) working = false; }
  }
  async function revoke(id: string) {
    if (working || disposed) return;
    working = true; failure = null;
    try {
      await client.revokeDeviceToken(id);
      if (!disposed) {
        devices = devices.map(device => device.id === id ? { ...device, revokedAt: new Date().toISOString() } : device);
        if (issued?.id === id) issued = null;
      }
    } catch (error) { reject(error); }
    finally { if (!disposed) working = false; }
  }
  onMount(() => { void load(); });
</script>

<h1>Devices</h1>
<p>Give an app a separate token for your account. Tokens follow your library access and can be revoked without signing out your other apps.</p>
{#if loaded}
  {#if devices.length}<div class="table-scroll"><table>
    <thead><tr><th>Name</th><th>Access</th><th>Expires</th><th>State</th><th>Action</th></tr></thead>
    <tbody>{#each devices as device (device.id)}<tr>
      <td>{device.name}</td><td>{device.scopes.join(', ')}</td><td>{device.expiresAt ? new Date(device.expiresAt).toLocaleDateString() : 'Never'}</td>
      <td>{device.revokedAt ? 'Revoked' : device.expiresAt && Date.parse(device.expiresAt) <= Date.now() ? 'Expired' : 'Active'}</td>
      <td>{#if !device.revokedAt}<button type="button" disabled={working} aria-label={`Revoke ${device.name}`} onclick={() => void revoke(device.id)}>Revoke</button>{/if}</td>
    </tr>{/each}</tbody>
  </table></div>{:else}<InlineNotice>No device tokens yet.</InlineNotice>{/if}
  {#if issued}{@const createdToken = issued}<section aria-label="New device token">
    <p>Copy this token now. It will not be shown again after you leave this page.</p>
    <FormField label="Device access token">{#snippet children(attributes)}<input {...attributes} readonly value={createdToken.token} autocomplete="off" />{/snippet}</FormField>
    <button type="button" onclick={() => issued = null}>Hide token</button>
  </section>{/if}
  {#if needsReconciliation}<button type="button" disabled={working} onclick={() => void load()}>Retry device list</button>{/if}
  <form class="settings-form" onsubmit={(event) => { event.preventDefault(); void create(); }}>
    <div class="settings-fields">
      <FormField label="Device name" help="Choose a name you’ll recognize, such as Living room tablet.">{#snippet children(attributes)}<input {...attributes} bind:value={name} required maxlength="80" disabled={working} />{/snippet}</FormField>
      <FormField label="Device permissions" help="Read-only apps can browse and download.">{#snippet children(attributes)}<select {...attributes} bind:value={permission} disabled={working}><option value="read">Read only</option><option value="write">Read and write</option></select>{/snippet}</FormField>
      <FormField label="Token lifetime" help="Create another token when this one expires.">{#snippet children(attributes)}<select {...attributes} bind:value={lifetime} disabled={working}><option value="604800">7 days</option><option value="2592000">30 days</option><option value="7776000">90 days</option><option value="31536000">1 year</option></select>{/snippet}</FormField>
    </div>
    <button type="submit" disabled={working || needsReconciliation}>Create device token</button>
  </form>
{:else if working}<InlineNotice kind="status">Loading devices…</InlineNotice>{:else}<button type="button" onclick={() => void load()}>Retry devices</button>{/if}
{#if failure}<InlineNotice kind="error">{failure}</InlineNotice>{/if}
