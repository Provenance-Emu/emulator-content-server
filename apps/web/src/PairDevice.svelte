<script lang="ts">
  import type { ContentClient } from '@ecs/client';
  import { untrack } from 'svelte';
  import FormField from './components/FormField.svelte';
  import InlineNotice from './components/InlineNotice.svelte';
  import { explain } from './lib/problems';

  let { client, initialPin, onpaired }: {
    client: ContentClient;
    initialPin: string;
    onpaired: () => void;
  } = $props();

  let pin = $state(untrack(() => /^[0-9]{6}$/.test(initialPin) ? initialPin : ''));
  let candidate = $state<{ id: string; name: string } | null>(null);
  let working = $state(false);
  let approved = $state(false);
  let failure = $state<string | null>(null);

  async function inspect(event: SubmitEvent) {
    event.preventDefault();
    if (working) return;
    working = true;
    approved = false;
    failure = null;
    candidate = null;
    try {
      candidate = await client.inspectDevicePairing(pin);
    } catch (error) {
      failure = explain(error);
    } finally {
      working = false;
    }
  }

  async function approve() {
    if (!candidate || working) return;
    working = true;
    failure = null;
    try {
      await client.approveDevicePairing(candidate.id, pin);
      pin = '';
      candidate = null;
      approved = true;
      onpaired();
    } catch (error) {
      candidate = null;
      failure = explain(error);
    } finally {
      working = false;
    }
  }
</script>

<section aria-label="Pair a device">
  <h2>Pair a device</h2>
  <form class="settings-form" onsubmit={inspect}>
    <FormField label="Pairing PIN" help="Enter the six digits shown on the device.">
      {#snippet children(attributes)}
        <input {...attributes} inputmode="numeric" pattern={'[0-9]{6}'} maxlength="6" required
          autocomplete="off" bind:value={pin} disabled={working}
          oninput={() => { candidate = null; approved = false; }} />
      {/snippet}
    </FormField>
    <button type="submit" disabled={working || !/^[0-9]{6}$/.test(pin)}>Review device</button>
  </form>
  {#if candidate}
    <p>Allow <strong>{candidate.name}</strong> to browse and download from your libraries?</p>
    <button type="button" disabled={working} onclick={approve}>Approve read access</button>
  {/if}
  {#if approved}<InlineNotice kind="status">Approved. The device can now connect.</InlineNotice>{/if}
  {#if failure}<InlineNotice kind="error">{failure}</InlineNotice>{/if}
</section>
