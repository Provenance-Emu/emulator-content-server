<script lang="ts">
  import { onMount } from 'svelte';
  import type { ContentClient } from '@ecs/client';
  import InlineNotice from './components/InlineNotice.svelte';
  import Modal from './components/Modal.svelte';
  import { pairingQR } from './lib/pairing-qr';
  import { explain } from './lib/problems';

  let { client, origin, onclose }: { client: ContentClient; origin: string; onclose: () => void } = $props();
  let address = $state('');
  let invitation = $state<Awaited<ReturnType<ContentClient['createDevicePairingInvitation']>> | null>(null);
  let busy = $state(false);
  let expired = $state(false);
  let failure = $state<string | null>(null);
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function shareableOrigin(input: string): string | null {
    try {
      const url = new URL(input.trim());
      if (
        !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash ||
        ['localhost', '[::1]', '0.0.0.0', '[::]'].includes(url.hostname) || url.hostname.startsWith('127.')
      ) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  function invitationQR() {
    if (!invitation) return null;
    const url = new URL('ecs-pair://invite');
    url.searchParams.set('server', address);
    url.searchParams.set('id', invitation.id);
    url.searchParams.set('pin', invitation.pin);
    return pairingQR(url.href);
  }

  function withdraw() {
    clearTimeout(timer);
    if (invitation) void client.withdrawDevicePairingInvitation(invitation.id).catch(() => {});
    invitation = null;
  }

  async function create() {
    const server = shareableOrigin(address);
    if (busy || !server) return;
    address = server;
    busy = true;
    expired = false;
    failure = null;
    try {
      const created = await client.createDevicePairingInvitation();
      if (disposed) {
        await client.withdrawDevicePairingInvitation(created.id).catch(() => {});
        return;
      }
      invitation = created;
      timer = setTimeout(() => {
        invitation = null;
        expired = true;
      }, created.expiresInSeconds * 1000);
    } catch (error) {
      if (!disposed) failure = explain(error);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    address = shareableOrigin(origin) ?? '';
    if (address) void create();
    return () => {
      disposed = true;
      withdraw();
    };
  });
</script>

<Modal title="Pair a device" {onclose}>
  {#if invitation}
    {@const code = invitationQR()}
    <p>Open the emulator’s pairing scanner and scan this code. It grants read-only access and expires in five minutes.</p>
    {#if code}
      <svg class="code" aria-label="Server pairing QR code" role="img" width="252" height="252" viewBox={`-4 -4 ${code.size} ${code.size}`} shape-rendering="crispEdges">
        <rect x="-4" y="-4" width={code.size} height={code.size} fill="#fff" />
        <path d={code.path} fill="#000" />
      </svg>
    {/if}
    <p class="address">{address} · <strong class="pin">{invitation.pin}</strong></p>
    <button type="button" onclick={withdraw}>Change server address</button>
  {:else}
    <form onsubmit={(event) => { event.preventDefault(); void create(); }}>
      <label>
        Server address reachable from your device
        <input type="url" bind:value={address} placeholder="http://server.local:8473" required disabled={busy} />
      </label>
      {#if expired}<p role="status">The code expired. Create a new one to pair.</p>{/if}
      <button class="primary" type="submit" disabled={busy || !shareableOrigin(address)}>
        {busy ? 'Creating code…' : 'Create pairing QR'}
      </button>
    </form>
  {/if}
  {#if failure}<InlineNotice kind="error">{failure}</InlineNotice>{/if}
</Modal>

<style>
  .code { display: block; max-width: 100%; height: auto; }
  .address { overflow-wrap: anywhere; }
  .pin { font-variant-numeric: tabular-nums; letter-spacing: 0.13em; }
  form, label { display: grid; gap: 0.75rem; }
  form button { justify-self: start; }
</style>
