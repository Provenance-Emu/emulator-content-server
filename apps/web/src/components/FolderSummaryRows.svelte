<script lang="ts">
  import type { ContentRoot, ContentRootSummary } from '@ecs/client';
  let {
    summaries,
    onview,
    scanFailures = {}, busy = false, onscan, onremove, onassign, onorganization, onwatching,
  }: {
    summaries: ContentRootSummary[];
    onview: (rootId: string, libraryId: string | null) => void;
    scanFailures?: Record<string, string>; busy?: boolean;
    onorganization?: (root: ContentRoot) => void;
    onwatching?: (root: ContentRoot) => void;
    onscan?: (rootId: string) => void; onremove?: (root: ContentRoot) => void; onassign?: (root: ContentRoot) => void;
  } = $props();
</script>

{#if !summaries.length}<p class="dim">
    No library folders. Files stay in their server folders when indexed.
  </p>{:else}
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>Library folder</th>
          <th>Availability</th>
          <th>Last scan</th>
          <th>Indexed files</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each summaries as summary (summary.root.id)}<tr>
            <td>
              <strong>{summary.root.label}</strong>
              <br />
              <span class="path">{summary.root.path}</span>
            </td>
            <td>
              {summary.online === null ? 'Unknown' : summary.online ? 'Online' : 'Offline'}
              <small class="dim">
                Checked: {summary.lastCheckAt
                  ? new Date(summary.lastCheckAt).toLocaleString()
                  : 'Not checked'}
              </small>
            </td>
            <td>
              <span>{scanFailures[summary.root.id] ? 'Scan failed' : !summary.lastScanAt ? 'Needs a scan' : 'Scanned'}</span>
              <small class="dim">
                {summary.lastScanAt ? new Date(summary.lastScanAt).toLocaleString() : 'Not scanned'}
              </small>
            </td>
            <td>{summary.indexedFileCount}</td>
            <td>
              <button
                type="button"
                aria-label={`View files in ${summary.root.label}`}
                onclick={() => onview(summary.root.id, summary.root.libraryId)}
              >
                View files
              </button>
              {#if onscan}<button type="button" disabled={busy} aria-label={`${scanFailures[summary.root.id] ? 'Retry scan' : 'Scan folder'} ${summary.root.label}`} onclick={() => onscan?.(summary.root.id)}>{scanFailures[summary.root.id] ? 'Retry scan' : 'Scan folder'}</button>{/if}
              {#if onwatching}<button type="button" disabled={busy} aria-label={`Folder watching for ${summary.root.label}`} onclick={() => onwatching?.(summary.root)}>Folder watching</button>{/if}
              {#if onorganization}<button type="button" disabled={busy} aria-label={`Automatic organization for ${summary.root.label}`} onclick={()=>onorganization?.(summary.root)}>Automatic organization</button>{/if}
              {#if onremove}<button type="button" disabled={busy} aria-label={`Disconnect ${summary.root.label}`} onclick={() => onremove?.(summary.root)}>Disconnect</button>{/if}
              {#if onassign && summary.root.libraryId === null}<button type="button" disabled={busy} aria-label={`Assign ${summary.root.label}`} onclick={() => onassign?.(summary.root)}>Assign to library</button>{/if}
            </td>
          </tr>{/each}
      </tbody>
    </table>
  </div>{/if}
