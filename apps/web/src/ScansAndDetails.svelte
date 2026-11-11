<script lang="ts">
  import type { Library, LibraryOverview } from '@ecs/client';
  import { ContentError } from '@ecs/client';
  import { onMount } from 'svelte';
  import type { ServerContext } from './lib/application';
  import { automaticText, missingCount, overviewTotals } from './lib/library-overview';
  import { explain } from './lib/problems';
  import LibraryJobs from './LibraryJobs.svelte';

  let {
    context,
    libraries,
    onrejected,
    onchanged = () => {},
  }: {
    context: ServerContext;
    libraries: Library[];
    onrejected: (status: 401 | 403) => void;
    onchanged?: () => void;
  } = $props();

  let overview = $state<LibraryOverview | null>(null);
  let failure = $state<string | null>(null);
  let busy = $state('');
  let started = $state(0);
  let live = false;
  const totals = $derived(overviewTotals(overview?.folders ?? []));
  const count = (value: number) => value.toLocaleString();
  const libraryName = (id: string | null) =>
    id ? (libraries.find((library) => library.id === id)?.name ?? 'Library') : 'Unassigned';

  async function load() {
    try {
      const next = await context.client.libraryOverview();
      if (!live) return;
      overview = next;
      failure = null;
    } catch (error) {
      if (!live) return;
      failure = explain(error);
      if (error instanceof ContentError && (error.status === 401 || error.status === 403)) {
        live = false;
        onrejected(error.status);
      }
    }
  }
  onMount(() => {
    live = true;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  });
  async function run(kind: 'scan' | 'match', rootId: string) {
    if (busy) return;
    busy = `${kind}:${rootId}`;
    try {
      await context.client.createLibraryJob(
        kind === 'scan'
          ? { kind, rootId }
          : { kind, rootId, options: { online: true, checksum: true, allowExactNames: true } },
      );
      failure = null;
      // The activity panel below picks up the running job when it remounts.
      started++;
      await load();
    } catch (error) {
      failure = explain(error);
    } finally {
      busy = '';
    }
  }
</script>

<h1>Scans &amp; details</h1>
<p class="dim">
  A scan finds the games in a folder. The server then looks up each game's name, details, and cover.
  This page shows what it found and what still needs you.
</p>
{#if failure}<p role="alert" class="problem">{failure}</p>{/if}
{#if overview}
  <p class="scan-automatic" role="status">
    <span class="dot" class:up={overview.automaticMatching} class:down={!overview.automaticMatching}></span>
    {overview.automaticMatching
      ? 'Automatic matching is on. New games get details and a cover after each scan.'
      : 'Automatic matching is off on this server. Use Find missing for each folder.'}
  </p>
  <dl class="scan-totals" aria-label="Library totals">
    <div><dt>Games</dt><dd>{count(totals.games)}</dd></div>
    <div><dt>With details</dt><dd>{count(totals.withDetails)}</dd></div>
    <div><dt>With a cover</dt><dd>{count(totals.withCover)}</dd></div>
    {#if totals.unavailable}<div><dt>Offline</dt><dd>{count(totals.unavailable)}</dd></div>{/if}
  </dl>
  <section aria-labelledby="scan-folders-heading">
    <h2 id="scan-folders-heading">Folders</h2>
    {#if overview.folders.length}
      <div class="table-scroll">
        <table class="scan-folders">
          <thead>
            <tr><th>Folder</th><th>Games</th><th>Details</th><th>Covers</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr>
          </thead>
          <tbody>
            {#each overview.folders as folder (folder.rootId)}
              <tr>
                <td><strong>{folder.label}</strong><small class="dim">{libraryName(folder.libraryId)}</small></td>
                <td data-label="Games">{count(folder.games)}</td>
                <td data-label="Details">{count(folder.withDetails)}</td>
                <td data-label="Covers">{count(folder.withCover)}</td>
                <td>
                  {automaticText(overview.automaticMatching, folder)}
                  {#if folder.unavailable}<small class="dim">{count(folder.unavailable)} offline or not downloaded.</small>{/if}
                </td>
                <td>
                  <div class="scan-actions">
                    <button type="button" disabled={!!busy} aria-label={`Scan ${folder.label}`} onclick={() => void run('scan', folder.rootId)}>Scan now</button>
                    {#if missingCount(folder)}<button type="button" disabled={!!busy} aria-label={`Find missing details in ${folder.label}`} onclick={() => void run('match', folder.rootId)}>Find missing</button>{/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p>No folders yet. Add one in Libraries, and its games appear here after the first scan.</p>
    {/if}
  </section>
{:else if !failure}
  <p class="dim" role="status">Loading library status…</p>
{/if}
<section aria-labelledby="scan-activity-heading">
  <h2 id="scan-activity-heading">Activity and review</h2>
  {#key started}<LibraryJobs {context} scope={{}} {libraries} folders={overview?.folders ?? []} {onchanged} />{/key}
</section>
