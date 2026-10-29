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
</script>

<div class="matching-fields">
<label class="matching-check"><input type="checkbox" bind:checked={online} {disabled} /> Include online providers</label>
  <label class="matching-field">Match manager <select bind:value={managerId} {disabled}>{#each plugins.filter((p)=>p.kind==='manager') as plugin (plugin.id)}<option value={plugin.id}>{plugin.name}</option>{/each}</select></label>
  <fieldset class="provider-list" {disabled}>
    <legend>Matching providers</legend>
    {#each plugins.filter((p)=>p.kind==='provider') as plugin (plugin.id)}
      <label class="matching-check"><input type="checkbox" bind:group={providerIds} value={plugin.id} disabled={disabled||(plugin.network&&!online)} /> <span>{plugin.name} <span class="dim">· {plugin.capabilities.join(', ')} · ({plugin.network ? 'online' : 'local'})</span></span></label>
    {/each}
  </fieldset>
  <p class="dim">Provider plugins find candidates. Manager plugins choose which providers run.</p>
</div>

<style>
  .provider-list { display: grid; gap: var(--space-1); margin: var(--space-3) 0; padding: 0; border: 0; }
  .provider-list legend { margin-bottom: var(--space-2); color: var(--ink-dim); }
</style>
