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

<label><input type="checkbox" bind:checked={online} {disabled} /> Include online providers</label>
<details>
  <summary>Providers and manager</summary>
  <label>Match manager <select bind:value={managerId} {disabled}>{#each plugins.filter((p)=>p.kind==='manager') as plugin (plugin.id)}<option value={plugin.id}>{plugin.name}</option>{/each}</select></label>
  <fieldset {disabled}>
    <legend>Matching providers</legend>
    {#each plugins.filter((p)=>p.kind==='provider') as plugin (plugin.id)}
      <label><input type="checkbox" bind:group={providerIds} value={plugin.id} disabled={disabled||(plugin.network&&!online)} /> {plugin.name} · {plugin.capabilities.join(', ')} {plugin.network ? '(online)' : '(local)'}</label>
    {/each}
  </fieldset>
  <p class="dim">Provider plugins find candidates. Manager plugins choose which providers run.</p>
</details>

<style>
  details { margin: 1rem 0; }
  fieldset { display: flex; flex-direction: column; gap: .75rem; margin: 1rem 0; }
</style>
