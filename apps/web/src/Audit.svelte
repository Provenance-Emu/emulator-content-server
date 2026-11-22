<script lang="ts">
  import type { AuditEvent, ContentClient } from '@ecs/client';
  import Icon from './components/Icon.svelte';
  import { auditLabel, auditNeedsAttention } from './lib/audit-labels';
  import { explain } from './lib/problems';

  let { client, noted }: { client: ContentClient; noted: number } = $props();

  let events = $state<AuditEvent[]>([]);
  let names = $state<Record<string, string>>({});
  let failure = $state<string | null>(null);

  async function load(): Promise<void> {
    try {
      events = (await client.audit(100)).events;
      failure = null;
    } catch (error) {
      failure = explain(error);
    }
    // Names make the log readable; without them it still says what happened.
    try {
      names = Object.fromEntries((await client.users()).items.map((user) => [user.id, user.username]));
    } catch {
      /* Only the owner may list accounts. */
    }
  }

  /** Today is a time; anything earlier carries its date. */
  function when(value: string): string {
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return value;
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return at.toDateString() === new Date().toDateString()
      ? time
      : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
  }
  const who = (event: AuditEvent) => (event.actorId ? (names[event.actorId] ?? 'Someone') : 'Not signed in');

  // `noted` changes when the owner creates or revokes a grant, which is the
  // event the log should show without a manual refresh.
  $effect(() => {
    void noted;
    void load();
  });
</script>

<section class="audit">
  <div class="row">
    <h2>What happened</h2>
    <button type="button" class="icon-only" aria-label="Refresh" title="Refresh" onclick={() => void load()}>
      <Icon name="refresh" />
    </button>
  </div>
  {#if events.length === 0}
    <p class="dim">Nothing has been recorded yet.</p>
  {:else}
    <ul class="audit-rows">
      {#each events as event (event.id)}
        <li class:attention={auditNeedsAttention(event.action)}>
          <div class="audit-main">
            <strong>{auditLabel(event.action)}</strong>
            <span class="dim">{who(event)} · <time datetime={event.at}>{when(event.at)}</time></span>
          </div>
          <details>
            <summary>Details</summary>
            <dl>
              <div><dt>Recorded as</dt><dd><code>{event.action}</code></dd></div>
              {#if event.resourceId}<div><dt>{event.resourceType ?? 'Item'}</dt><dd><code>{event.resourceId}</code></dd></div>{/if}
              {#if event.actorId}<div><dt>Account</dt><dd><code>{event.actorId}</code></dd></div>{/if}
              <div><dt>When</dt><dd>{new Date(event.at).toLocaleString()}</dd></div>
            </dl>
          </details>
        </li>
      {/each}
    </ul>
  {/if}
  {#if failure}
    <p class="problem" role="alert">{failure}</p>
  {/if}
</section>

<style>
  .audit-rows {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .audit-rows li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: baseline;
    gap: var(--space-1) var(--space-4);
    padding: var(--space-3) 0;
    border-top: var(--border-width) solid var(--color-border);
  }
  .audit-rows li.attention {
    padding-inline-start: var(--space-3);
    border-inline-start: 3px solid var(--color-warning);
  }
  .audit-main {
    display: grid;
    min-width: 0;
  }
  .audit-main .dim {
    font-size: var(--text-small);
  }
  .audit-rows details {
    font-size: var(--text-small);
  }
  .audit-rows details[open] {
    grid-column: 1 / -1;
  }
  .audit-rows summary {
    cursor: pointer;
    color: var(--color-text-muted);
  }
  .audit-rows dl {
    display: grid;
    gap: var(--space-1);
    margin: var(--space-2) 0 0;
  }
  .audit-rows dl div {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .audit-rows dt {
    color: var(--color-text-muted);
    text-transform: capitalize;
  }
  .audit-rows dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
