<script lang="ts">
  import type { ServerContext } from './lib/application';
  import type { FolderSelectionAdapter } from './lib/folder-selection';
  import type { SetupMode } from './lib/setup-progress';
  import LibraryShell from './LibraryShell.svelte';
  let {
    context,
    folderSelection,
    setupCode,
    revealSetupCode,
    setupGuide, onsetupclose, onchoosecomputer,
  }: { context: ServerContext; folderSelection?: FolderSelectionAdapter; setupCode?: string; revealSetupCode?: () => Promise<void>; setupGuide?: SetupMode; onsetupclose?: () => void; onchoosecomputer?: () => void } = $props();
</script>

{#key context.key}<LibraryShell {context} {folderSelection} {setupCode} {revealSetupCode} {setupGuide} {onsetupclose} {onchoosecomputer} />{/key}
