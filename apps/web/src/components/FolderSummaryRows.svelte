<script lang="ts">
  import type { ContentRootSummary } from '@ecs/client';
  let {
    summaries,
    onview,
  }: {
    summaries: ContentRootSummary[];
    onview: (rootId: string, libraryId: string | null) => void;
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
              {summary.scanState}
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
            </td>
          </tr>{/each}
      </tbody>
    </table>
  </div>{/if}
