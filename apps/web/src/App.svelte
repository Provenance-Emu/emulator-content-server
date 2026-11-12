<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ServerContext } from './lib/application';
  import type { FolderSelectionAdapter } from './lib/folder-selection';
  import type { SetupMode } from './lib/setup-progress';
  import LibraryShell from './LibraryShell.svelte';
  let {
    context,
    folderSelection,
    setupCode,
    revealSetupCode,
    setupGuide, onsetupclose, onchoosecomputer, desktopUpdates,
  }: { context: ServerContext; folderSelection?: FolderSelectionAdapter; setupCode?: string; revealSetupCode?: () => Promise<void>; setupGuide?: SetupMode; onsetupclose?: () => void; onchoosecomputer?: () => void; desktopUpdates?: Snippet } = $props();
</script>

{#key context.key}<LibraryShell {context} {folderSelection} {setupCode} {revealSetupCode} {setupGuide} {onsetupclose} {onchoosecomputer} {desktopUpdates} />{/key}
