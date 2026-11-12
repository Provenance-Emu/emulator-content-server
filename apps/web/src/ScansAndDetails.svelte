<script lang="ts">
  import type { ContentRoot, ContentRootSummary, Library, LibraryOverview, LibraryScope } from '@ecs/client';
  import { ContentError } from '@ecs/client';
  import { onMount } from 'svelte';
  import type { ServerContext } from './lib/application';
  import { automaticText, missingCount, overviewTotals } from './lib/library-overview';
  import { explain } from './lib/problems';
  import FolderOrganizationPolicy from './FolderOrganizationPolicy.svelte';
  import FolderWatchPolicy from './FolderWatchPolicy.svelte';
  import LibraryCleanup from './LibraryCleanup.svelte';
  import LibraryJobs from './LibraryJobs.svelte';
  import Modal from './components/Modal.svelte';

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
  let summaries = $state<ContentRootSummary[]>([]);
  let failure = $state<string | null>(null);
  let actionFailure = $state<string | null>(null);
  let busy = $state('');
  let started = $state(0);
  let selectedJob = $state<string>();
  let activityHeading = $state<HTMLHeadingElement>();
  let folderPolicy = $state<{
    kind: 'watch' | 'organization';
    root: Pick<ContentRoot, 'id' | 'label' | 'libraryId'>;
  } | null>(null);
  let cleanupLibrary = $state('');
  const cleanupScope = $derived<LibraryScope | null>(
    cleanupLibrary === 'unassigned'
      ? { unassigned: true }
      : libraries.some((library) => library.id === cleanupLibrary)
        ? { libraryId: cleanupLibrary }
        : null,
  );
  let live = false;
  const totals = $derived(overviewTotals(overview?.folders ?? []));
  const count = (value: number) => value.toLocaleString();
  const libraryName = (id: string | null) =>
    id ? (libraries.find((library) => library.id === id)?.name ?? 'Library') : 'Unassigned';

  async function load() {
    try {
      const [next, roots] = await Promise.all([
        context.client.libraryOverview(),
        context.client.rootSummaries(),
      ]);
      if (!live) return;
      overview = next;
      summaries = roots.items;
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
    actionFailure = null;
    try {
      const { job } = await context.client.createLibraryJob(
        kind === 'scan'
          ? { kind, rootId }
          : { kind, rootId, options: { online: true, checksum: true, allowExactNames: true } },
      );
      failure = null;
      showJob(job.id);
      await load();
    } catch (error) {
      actionFailure = explain(error);
    } finally {
      busy = '';
    }
  }
  function showJob(id: string) {
    selectedJob = id;
    started++;
    activityHeading?.focus();
  }
</script>

{#if folderPolicy}
  <Modal
    title={folderPolicy.kind === 'watch' ? 'Folder watching' : 'Automatic organization'}
    onclose={() => (folderPolicy = null)}
  >
    {#if folderPolicy.kind === 'watch'}
      <FolderWatchPolicy client={context.client} root={folderPolicy.root} {onrejected} />
    {:else}
      <FolderOrganizationPolicy client={context.client} root={folderPolicy.root} {onrejected} />
    {/if}
  </Modal>
{/if}

<h1>Scans &amp; details</h1>
<p class="dim">
  Checking files updates which games are in your library. Looking up details and covers uses local
  game information and online catalogs. Review the results and recover stopped work below.
</p>
{#if failure}<p role="alert" class="problem">{failure}</p>{/if}
{#if actionFailure}<p role="alert" class="problem">{actionFailure}</p>{/if}
{#if overview}
  <p class="scan-automatic" role="status">
    <span class="dot" class:up={overview.automaticMatching} class:down={!overview.automaticMatching}></span>
    {overview.automaticMatching
      ? 'Automatic lookup is on. The server checks new and changed games first and retries older misses when the queue is idle.'
      : 'Automatic lookup is off on this server. You can still look up details and covers from this page.'}
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
            <tr><th>Folder</th><th>Games</th><th>Details</th><th>Covers</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {#each overview.folders as folder (folder.rootId)}
              {@const root = { id: folder.rootId, label: folder.label, libraryId: folder.libraryId }}
              {@const summary = summaries.find((entry) => entry.root.id === root.id)}
              <tr>
                <td><strong>{folder.label}</strong><small class="dim">{libraryName(folder.libraryId)}</small></td>
                <td data-label="Games">{count(folder.games)}</td>
                <td data-label="Details">{count(folder.withDetails)}</td>
                <td data-label="Covers">{count(folder.withCover)}</td>
                <td>
                  {#if summary}
                    <small class:problem={summary.scanState === 'failed'}>
                      {summary.online === false ? 'Folder offline.'
                        : summary.scanState === 'pending' ? 'Checking files…'
                        : summary.scanState === 'failed' ? 'File check stopped. Check files to retry.'
                        : summary.lastScanAt ? `Files checked ${new Date(summary.lastScanAt).toLocaleString()}.`
                        : 'Waiting for the first file check.'}
                    </small>
                  {/if}
                  {automaticText(overview.automaticMatching, folder)}
                  {#if folder.unavailable}<small class="dim">{count(folder.unavailable)} offline or not downloaded.</small>{/if}
                  {#if typeof folder.automatic.stoppedJobId === 'string'}
                    <small><button type="button" onclick={() => showJob(String(folder.automatic.stoppedJobId))}>Review stopped lookup</button></small>
                  {:else if typeof folder.automatic.jobId === 'string'}
                    <small><button type="button" onclick={() => showJob(String(folder.automatic.jobId))}>View lookup activity</button></small>
                  {/if}
                </td>
                <td>
                  <div class="scan-actions">
                    <button type="button" disabled={!!busy} aria-label={`Check files in ${folder.label}`} onclick={() => void run('scan', folder.rootId)}>Check files</button>
                    {#if missingCount(folder)}<button type="button" disabled={!!busy} aria-label={`Look up details and covers in ${folder.label}`} onclick={() => void run('match', folder.rootId)}>Look up details</button>{/if}
                    <button
                      type="button"
                      aria-label={`Watch settings for ${folder.label}`}
                      onclick={() => (folderPolicy = { kind: 'watch', root })}
                    >Watch settings</button>
                    <button
                      type="button"
                      aria-label={`Organization settings for ${folder.label}`}
                      onclick={() => (folderPolicy = { kind: 'organization', root })}
                    >Organization</button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p>Add a folder in Libraries to start checking for games.</p>
    {/if}
  </section>
{:else if !failure}
  <p class="dim" role="status">Loading library status…</p>
{/if}
<section aria-labelledby="scan-activity-heading">
  <h2 id="scan-activity-heading" tabindex="-1" bind:this={activityHeading}>Activity and review</h2>
  <h3>File checks and lookups</h3>
  {#key started}<LibraryJobs {context} scope={{}} {libraries} folders={overview?.folders ?? []} initialJobId={selectedJob} {onchanged} />{/key}
  <h3>Library cleanup</h3>
  <label class="matching-field">
    Cleanup library
    <select bind:value={cleanupLibrary}>
      <option value="">Choose a library</option>
      {#each libraries as library (library.id)}
        <option value={library.id}>{library.name}</option>
      {/each}
      <option value="unassigned">Unassigned folders</option>
    </select>
  </label>
  {#if cleanupScope}
    <LibraryCleanup {context} scope={cleanupScope} {onchanged} />
  {/if}
</section>
