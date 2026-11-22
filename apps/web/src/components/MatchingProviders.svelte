<script lang="ts">
  import type { MatchingPlugin } from '@ecs/client';
  let {
    plugins,
    online = $bindable(false),
    providerIds = $bindable<string[]>([]),
    managerId = $bindable('org.ecs.matches'),
    disabled = false,
  }: {
    plugins: MatchingPlugin[];
    online: boolean;
    providerIds: string[];
    managerId: string;
    disabled?: boolean;
  } = $props();
  const managers = $derived(plugins.filter((p) => p.kind === 'manager'));
  /** A source's name without its catalog version. */
  const plain = (name: string) => name.split(' · ')[0] ?? name;
  const FINDS: Record<string, string> = { metadata: 'details', rom: 'system', patch: 'patches' };
  const finds = (capability: string) => FINDS[capability] ?? capability;
</script>

<div class="matching-fields">
<label class="matching-check"><input type="checkbox" bind:checked={online} {disabled} /> Include online providers</label>
  <details class="matching-disclosure sources">
    <summary>Choose where to look</summary>
    <div class="matching-disclosure-content">
      {#if managers.length > 1}<label class="matching-field">Match manager <select bind:value={managerId} {disabled}>{#each managers as plugin (plugin.id)}<option value={plugin.id}>{plugin.name}</option>{/each}</select></label>{/if}
      <fieldset class="provider-list" {disabled}>
        <legend>Matching providers</legend>
        {#each plugins.filter((p)=>p.kind==='provider') as plugin (plugin.id)}
          <label class="matching-check"><input type="checkbox" bind:group={providerIds} value={plugin.id} disabled={disabled||(plugin.network&&!online)} /> <span>{plain(plugin.name)} <span class="dim">· {plugin.capabilities.map(finds).join(', ')} · {plugin.network ? 'online' : 'on this server'}</span></span></label>
        {/each}
      </fieldset>
    </div>
  </details>
</div>

<style>
  .provider-list { display: grid; gap: var(--space-1); margin: var(--space-3) 0; padding: 0; border: 0; }
  .provider-list legend { margin-bottom: var(--space-2); color: var(--ink-dim); }
  .sources summary { font-size: var(--text-small); }
</style>
