<script lang="ts">
  import { onMount } from 'svelte';
  import { ContentError, type ContentClient, type DevicePairingPending } from '@ecs/client';
  import InlineNotice from './components/InlineNotice.svelte';
  import { explain } from './lib/problems';
  import { pairingQR } from './lib/pairing-qr';

  let { client, onrejected, oncompleted }: {
    client: ContentClient;
    onrejected: (status: 401 | 403) => void;
    oncompleted: () => void;
  } = $props();

  let items = $state<DevicePairingPending[]>([]);
  let codes = $state<Record<string, string>>({});
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let unavailable = $state(false);
  let disposed = false;
  let retryAt = 0;

  function showError(error: unknown) {
    if (disposed) return;
    if (error instanceof ContentError && error.status === 429)
      retryAt = Date.now() + (error.retryAfterMs ?? 60_000);
    failure = explain(error);
    if (error instanceof ContentError && (error.status === 401 || error.status === 403)) {
      codes = {};
      onrejected(error.status);
    }
  }

  async function refresh() {
    if (disposed || busy || unavailable || Date.now() < retryAt) return;
    busy = true;
    try {
      const reply = await client.devicePairingRequests();
      if (disposed) return;
      const active = new Set(reply.items.map(({ id }) => id));
      if (items.some((entry) => entry.approved && !active.has(entry.id))) oncompleted();
      codes = Object.fromEntries(Object.entries(codes).filter(([id]) => active.has(id)));
      items = reply.items;
      failure = null;
    } catch (error) {
      if (!disposed && error instanceof ContentError && error.status === 404) unavailable = true;
      else showError(error);
    } finally {
      busy = false;
    }
  }

  async function change(id: string, approve: boolean) {
    if (disposed || busy) return;
    busy = true;
    failure = null;
    try {
      if (approve) {
        const { pin } = await client.approveDevicePairingRequest(id);
        if (!disposed) {
          codes[id] = pin;
          items = items.map((item) => item.id === id ? { ...item, approved: true } : item);
        }
      } else {
        await client.dismissDevicePairingRequest(id);
        if (!disposed) {
          delete codes[id];
          items = items.filter((item) => item.id !== id);
        }
      }
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  });
</script>

{#if !unavailable}
  <section aria-label="Device access requests">
    <h2>Device access requests</h2>
    {#if !items.length}<p>Request access from the app to see it here.</p>{/if}
    {#each items as item (item.id)}
      {@const pin = codes[item.id]}
      <div class="request">
        <p><strong>{item.name}</strong> · {item.approved ? 'Waiting for the device to enter its code' : 'Requested read access'}</p>
        {#if pin}
          {@const code = pairingQR(`ecs-pair:${item.id}:${pin}`)}
          <p>Enter <strong class="pin">{pin}</strong> on the requesting device or scan this code in the app.</p>
          <svg aria-label="Pairing QR code" role="img" width="164" height="164" viewBox={`-4 -4 ${code.size} ${code.size}`} shape-rendering="crispEdges">
            <rect x="-4" y="-4" width={code.size} height={code.size} fill="#fff" />
            <path d={code.path} fill="#000" />
          </svg>
        {:else}
          <button type="button" disabled={busy} onclick={() => void change(item.id, true)}>{item.approved ? 'Show pairing code' : 'Approve read access'}</button>
        {/if}
        <button type="button" disabled={busy} onclick={() => void change(item.id, false)}>Dismiss</button>
      </div>
    {/each}
    {#if failure}<InlineNotice kind="error">{failure}</InlineNotice>{/if}
  </section>
{/if}

<style>
  .request { margin-block: 0.75rem; }
  .pin { font-variant-numeric: tabular-nums; letter-spacing: 0.13em; }
  svg { display: block; margin-block: 0.75rem; }
</style>
