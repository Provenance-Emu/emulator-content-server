<script lang="ts">
  import type { UndoToast } from '../lib/trash';

  let { toast }: { toast: UndoToast } = $props();
</script>

<!-- The live region stays mounted so a screen reader announces each new message. -->
<div class="undo-toast-region" role="status" aria-atomic="true">
  {#if $toast}<div class="undo-toast">
      <p class="undo-toast-message">
        {$toast.message}{#if $toast.failure}
          <span class="undo-toast-problem">It could not be restored. {$toast.failure}</span>{/if}
      </p>
      <div class="undo-toast-actions">
        {#if $toast.canUndo}<button
            type="button"
            class="primary"
            disabled={$toast.working}
            onclick={() => void toast.undo()}
          >{$toast.working ? 'Restoring…' : $toast.failure ? 'Try again' : 'Undo'}</button>{/if}
        <button type="button" disabled={$toast.working} onclick={() => toast.dismiss()}>Dismiss</button>
      </div>
    </div>{/if}
</div>
