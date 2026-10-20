<script lang="ts">
  import type { BrowseCategory } from '@ecs/client';
  import { CATEGORY_LABELS } from '../lib/content-format';
  let {
    selected,
    onchange,
  }: {
    selected: BrowseCategory;
    onchange: (category: BrowseCategory) => void;
  } = $props();
  const categories = Object.keys(CATEGORY_LABELS) as BrowseCategory[];
  function navigate(event: KeyboardEvent, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % categories.length;
    else if (event.key === 'ArrowLeft') next = (index + categories.length - 1) % categories.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = categories.length - 1;
    else return;
    event.preventDefault();
    const category = categories[next];
    if (category) onchange(category);
    (event.currentTarget as HTMLElement).parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  }
</script>

<div class="category-tabs" role="tablist" aria-label="File categories">
  {#each categories as category, index}
    <button
      type="button"
      role="tab"
      id={`category-${category}`}
      aria-controls="collection-panel"
      aria-selected={selected === category}
      tabindex={selected === category ? 0 : -1}
      onclick={() => onchange(category)}
      onkeydown={(event) => navigate(event, index)}
    >
      {CATEGORY_LABELS[category]}
    </button>
  {/each}
</div>
