<script lang="ts">
  import type { ServerContext } from './lib/application';
  import type { FolderSelectionAdapter } from './lib/folder-selection';
  import LibraryShell from './LibraryShell.svelte';
  let {
    context,
    folderSelection,
    setupCode,
    revealSetupCode,
  }: { context: ServerContext; folderSelection?: FolderSelectionAdapter; setupCode?: string; revealSetupCode?: () => Promise<void> } = $props();
</script>

{#key context.key}<LibraryShell {context} {folderSelection} {setupCode} {revealSetupCode} />{/key}
