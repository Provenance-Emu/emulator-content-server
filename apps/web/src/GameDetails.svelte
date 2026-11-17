<script lang="ts">
  import type { SourceFile } from '@ecs/client';
  import { tick, untrack } from 'svelte';
  import FormField from './components/FormField.svelte';
  import type { MatchingController } from './lib/matching';
  import { detailText } from './lib/matching-slots';
  let {
    matching,
    source,
    name,
    editing = $bindable(false),
    onchanged,
  }: {
    matching: MatchingController;
    /** What the collection already knew, shown until the saved details have loaded. */
    source: SourceFile | null;
    name: string;
    editing?: boolean;
    onchanged: () => void;
  } = $props();
  const FIELDS = [
    ['publisher', 'Publisher'],
    ['developer', 'Developer'],
    ['year', 'Year'],
    ['genre', 'Genre'],
    ['region', 'Region'],
    ['language', 'Language'],
  ] as const;
  type Field = (typeof FIELDS)[number][0] | 'description';
  const metadata = $derived($matching.saved?.matches.find((match) => match.kind === 'metadata'));
  const details = $derived<Partial<Record<Field, string>>>(
    detailText($matching.saved ? metadata?.metadata : source?.details),
  );
  const shown = $derived(FIELDS.filter(([key]) => details[key]));
  const unavailable = $derived(
    !!$matching.saving || $matching.savedLoading || $matching.savedLoadFailed || !$matching.saved,
  );
  let draft = $state({ title: '', description: '' } as Record<'title' | Field, string>);
  let form = $state<HTMLFormElement>();
  $effect(() => {
    if (!editing) return;
    untrack(() => {
      draft = {
        title: metadata?.title ?? name,
        description: details.description ?? '',
        ...Object.fromEntries(FIELDS.map(([key]) => [key, details[key] ?? ''])),
      } as Record<'title' | Field, string>;
    });
    void tick().then(() => {
      form?.scrollIntoView({ block: 'nearest' });
      form?.querySelector<HTMLInputElement>('input')?.focus();
    });
  });
  async function save() {
    const title = draft.title.trim();
    if (!title || unavailable) return;
    // Every field is sent, so one that was emptied is cleared.
    const saved = await matching.saveDetails({
      title,
      details: {
        description: draft.description.trim(),
        ...Object.fromEntries(FIELDS.map(([key]) => [key, draft[key].trim()])),
      },
    });
    if (!saved) return;
    editing = false;
    onchanged();
  }
</script>

{#if editing || shown.length}
  <section class="game-details" aria-label="Details">
    <h2>Details</h2>
    {#if editing}
      <form
        bind:this={form}
        onsubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div class="details-fields">
          <div class="wide">
            <FormField label="Title">
              {#snippet children(attributes)}
                <input {...attributes} bind:value={draft.title} required maxlength="200" />
              {/snippet}
            </FormField>
          </div>
          {#each FIELDS as [key, label] (key)}
            <FormField {label}>
              {#snippet children(attributes)}
                <input {...attributes} bind:value={draft[key]} maxlength="200" />
              {/snippet}
            </FormField>
          {/each}
          <div class="wide">
            <FormField label="Description">
              {#snippet children(attributes)}
                <textarea {...attributes} bind:value={draft.description} maxlength="2000" rows="5"
                ></textarea>
              {/snippet}
            </FormField>
          </div>
        </div>
        <div class="ui-actions">
          <button type="button" disabled={$matching.saving === 'details'} onclick={() => (editing = false)}>Cancel</button>
          <button class="primary" type="submit" disabled={unavailable || !draft.title.trim()}>
            {$matching.saving === 'details' ? 'Saving…' : 'Save details'}
          </button>
        </div>
      </form>
    {:else}
      <dl class="details-list">
        {#each shown as [key, label] (key)}
          <div>
            <dt>{label}</dt>
            <dd>{details[key]}</dd>
          </div>
        {/each}
      </dl>
    {/if}
  </section>
{/if}

<style>
  .details-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    gap: var(--space-3) var(--space-6);
    margin: 0;
  }
  dt {
    color: var(--color-text-muted);
    font-size: var(--text-small);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .details-fields {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
    gap: var(--space-3) var(--space-4);
    margin-bottom: var(--space-4);
  }
  .wide {
    grid-column: 1 / -1;
  }
  .details-fields :global(input),
  .details-fields :global(textarea) {
    width: 100%;
  }
</style>
