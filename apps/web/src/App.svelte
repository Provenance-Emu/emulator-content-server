<script lang="ts">
  import type { ServerContext } from './lib/application';
  import type { FolderSelectionAdapter } from './lib/folder-selection';
  import LibraryShell from './LibraryShell.svelte';
  let {
    context,
    folderSelection,
  }: { context: ServerContext; folderSelection?: FolderSelectionAdapter } = $props();
</script>

{#key context.key}<LibraryShell {context} {folderSelection} />{/key}
