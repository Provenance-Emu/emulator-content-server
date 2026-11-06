<script lang="ts">
  import type { ServerContext } from './lib/application';
  import type { FolderSelectionAdapter } from './lib/folder-selection';
  import LibraryShell from './LibraryShell.svelte';
  let {
    context,
    folderSelection,
    setupCode,
  }: { context: ServerContext; folderSelection?: FolderSelectionAdapter; setupCode?: string } = $props();
</script>

{#key context.key}<LibraryShell {context} {folderSelection} {setupCode} />{/key}
