<script lang="ts">
  import type { BrowseCategory } from '@ecs/client';
  import { CATEGORY_LABELS } from '../lib/content-format';
  import Tabs from './Tabs.svelte';
  let {
    selected,
    onchange,
  }: {
    selected: BrowseCategory;
    onchange: (category: BrowseCategory) => void;
  } = $props();
  const tabs = (Object.keys(CATEGORY_LABELS) as BrowseCategory[])
    .map(id => ({ id, label: CATEGORY_LABELS[id] }));
</script>

<Tabs {tabs} {selected} {onchange} label="File categories" idPrefix="category" panelId="collection-panel" />
