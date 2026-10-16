<script lang="ts">
  import type { AuditEvent, ContentClient } from '@ecs/client';
  import { explain } from './lib/problems';

  let { client, noted }: { client: ContentClient; noted: number } = $props();

  let events = $state<AuditEvent[]>([]);
  let failure = $state<string | null>(null);

  async function load(): Promise<void> {
    try {
      events = (await client.audit(100)).events;
      failure = null;
    } catch (error) {
      failure = explain(error);
    }
  }

  function when(value: string): string {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
  }

  // `noted` changes when the owner creates or revokes a grant, which is the
  // event the log should show without a manual refresh.
  $effect(() => {
    void noted;
    void load();
  });
</script>

<section>
  <div class="row">
    <h2>Audit</h2>
    <button type="button" onclick={() => void load()}>Refresh</button>
  </div>
  {#if events.length === 0}
    <p class="dim">No events yet.</p>
  {:else}
    <table>
      <thead>
        <tr><th>When</th><th>Action</th><th>Resource</th><th>Actor</th></tr>
      </thead>
      <tbody>
        {#each events as event (event.id)}
          <tr>
            <td>{when(event.at)}</td>
            <td>{event.action}</td>
            <td class="dim">
              {event.resourceType ?? ''}
              <span class="path">{event.resourceId ?? ''}</span>
            </td>
            <td class="path dim">{event.actorId ?? ''}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  {#if failure}
    <p class="problem">{failure}</p>
  {/if}
</section>
