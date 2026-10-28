<script lang="ts" generics="Id extends string">
  let { tabs, selected, onchange, label, idPrefix, panelId }: {
    tabs: readonly { id: Id; label: string }[];
    selected: Id;
    onchange: (id: Id) => void;
    label: string;
    idPrefix: string;
    panelId: string;
  } = $props();

  function navigate(event: KeyboardEvent, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const tab = tabs[next];
    if (tab) onchange(tab.id);
    (event.currentTarget as HTMLElement).parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
</script>

<div class="category-tabs" role="tablist" aria-label={label}>
  {#each tabs as tab, index (tab.id)}
    <button type="button" role="tab" id={`${idPrefix}-${tab.id}`} aria-controls={panelId}
      aria-selected={selected === tab.id} tabindex={selected === tab.id ? 0 : -1}
      onclick={() => onchange(tab.id)} onkeydown={event => navigate(event, index)}>{tab.label}</button>
  {/each}
</div>
