<script lang="ts">
  import type {
    ContentRootSummary,
    Library,
    LibraryBrowseEntry,
    LibraryScope,
    PlayerCoreDescriptor,
    SystemSummary,
  } from '@ecs/client';
  import { get } from 'svelte/store';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import type { ApplicationController, ServerContext } from './lib/application';
  import { createLibraryBrowser } from './lib/library-browser';
  import { createDetail, type DetailController } from './lib/detail';
  import { createPreviews } from './lib/previews';
  import { createBulkMatching } from './lib/bulk-matching';
  import { explain, isForbidden, isUnauthorized } from './lib/problems';
  import { entryKey } from './lib/content-format';
  import CategoryTabs from './components/CategoryTabs.svelte';
  import CollectionToolbar from './components/CollectionToolbar.svelte';
  import CollectionPage from './components/CollectionPage.svelte';
  import ViewState from './components/ViewState.svelte';
  import Modal from './components/Modal.svelte';
  import LibraryDetail from './LibraryDetail.svelte';
  import Upload from './Upload.svelte';
  import FolderPicker from './FolderPicker.svelte';
  import {createLibraryFolders} from './lib/library-folders';
  import { chooseFolder, type FolderContext } from './lib/folder-selection';
  import BulkMatching from './BulkMatching.svelte';
  let {
    context,
    application,
    folderContext,
    scope,
    rootId = '',
    rootIntent = 0,
    owner,
    libraries,
    onsettings,
  }: {
    context: ServerContext;
    application: ApplicationController;
    folderContext: FolderContext;
    scope: LibraryScope | null;
    rootId?: string;
    rootIntent?: number;
    owner: boolean;
    libraries: Library[];
    onsettings: () => void;
  } = $props();
  const browser = untrack(() => createLibraryBrowser(context.client, null));
  const authEpoch = untrack(() => get(application).authEpoch);
  const bulk = untrack(() => createBulkMatching(context.client, {
    changed: () => { if (!disposed) void browser.refresh(); },
    authorizationRejected: (status) => { rejectAccess(status); if (status === 403) void application.revalidate(); },
  }));
  let bulkOpen = $state(false);
  let disposed = false;
  // Keep controller identity intact for stale-instance and authorization-loss guards.
  let detail = $state.raw<DetailController | null>(null);
  let detailEnvelope = '';
  let detailSubscription: (() => void) | null = null;
  let systems = $state<SystemSummary[]>([]);
  let folders = $state<ContentRootSummary[]>([]);
  let playerCore = $state<PlayerCoreDescriptor | null>(null);
  let playerRequested = false;
  let upload = $state(false);
  let uploadMode = $state<'files'|'folder'>('files');
  let uploading = $state(false);
  let folderAdder = $state.raw<ReturnType<typeof createLibraryFolders>|null>(null);
  let addingFolder = $state(false);
  let addingFolderBusy = $state(false);
  let folderSelectionFailure = $state<string | null>(null);
  async function addServerFolder() {
    if (!scope || !('libraryId' in scope) || !owner || addingFolderBusy || (folderAdder && get(folderAdder).busy)) return;
    const libraryId = scope.libraryId;
    folderAdder?.dispose();
    const actionContext: FolderContext = {
      ...folderContext,
      isCurrent: () => !disposed && owner && !!scope && 'libraryId' in scope &&
        scope.libraryId === libraryId && (folderContext.isCurrent?.() ?? true),
      onchanged: async () => {
        await folderContext.onchanged?.();
        if (!disposed) { void browser.refresh(); folderRetry++; }
      },
    };
    const adder = createLibraryFolders(context.client, actionContext, { libraryId });
    folderAdder = adder;
    folderSelectionFailure = null;
    if (!actionContext.folderSelection) { addingFolder = true; return; }
    addingFolderBusy = true;
    try {
      const selected = await chooseFolder(actionContext, 'library-folder');
      if (selected && !disposed && folderAdder === adder) await adder.add(selected);
    } catch (error) {
      if (!disposed && folderAdder === adder) folderSelectionFailure = explain(error);
    } finally {
      if (!disposed && folderAdder === adder) addingFolderBusy = false;
    }
  }

  let region: HTMLDivElement;
  const previews = untrack(() =>
    createPreviews(context.client, { authorizationRejected: rejectAccess }),
  );
  function clearDetail() {
    detailSubscription?.();
    detailSubscription = null;
    detail?.dispose();
    detail = null;
    detailEnvelope = '';
  }
  function disposePrivate() {
    if (disposed) return;
    disposed = true;
    folderGeneration++;
    clearDetail();
    previews.dispose();
    bulk.dispose();
    folderAdder?.dispose();
    addingFolder=false;
    bulkOpen = false;
    browser.dispose();
    upload = false;
    folders = [];
  }
  function rejectAccess(status: 401 | 403 | 404) {
    if (disposed || get(application).authEpoch !== authEpoch) return;
    clearDetail();
    if (status === 401) {
      void application.signOut();
      disposePrivate();
    } else void browser.refresh({ clear: true });
  }
  function rejectUploadAccess(status: 401 | 403) {
    if (disposed || get(application).authEpoch !== authEpoch) return;
    upload = false;
    uploading = false;
    rejectAccess(status);
    if (status === 403) void application.revalidate();
  }
  let previousItems: LibraryBrowseEntry[] | null = null;
  const unsubscribeBrowser = browser.subscribe((state) => {
    if (disposed) return;
    if (state.status === 401) {
      rejectAccess(401);
      return;
    }
    if (previousItems !== state.items) {
      previousItems = state.items;
      void previews.setPage(state.items);
    }
    const envelope = state.active ? JSON.stringify(state.active) : '';
    if (envelope !== detailEnvelope) {
      clearDetail();
      if (state.active) {
        const opened = createDetail(context.client, state.active);
        detail = opened;
        detailEnvelope = envelope;
        detailSubscription = opened.subscribe((value) => {
          if (
            (value.status === 401 || value.status === 403 || value.status === 404) &&
            detail === opened
          )
            rejectAccess(value.status);
        });
        void opened.load();
      }
    }
  });
  let invalidation = untrack(() => get(application).invalidation);
  const unsubscribeApplication = untrack(() =>
    application.subscribe((state) => {
      if (disposed) return;
      if (!state.signedIn || state.authEpoch !== authEpoch) {
        disposePrivate();
        return;
      }
      if (!state.owner && (get(bulk).phase !== 'idle' || bulkOpen)) {
        bulk.reset();
        bulkOpen = false;
      }
      const selected = get(browser).scope;
      if (
        selected &&
        ('libraryId' in selected
          ? !state.libraries.some((library) => library.id === selected.libraryId)
          : !state.owner)
      ) {
        clearDetail();
        bulk.reset();
        bulkOpen = false;
        upload = false;
        void browser.selectScope(null);
      }
      if (state.invalidation !== invalidation) {
        invalidation = state.invalidation;
        void browser.refresh().then(() => {
          if (!disposed && detail) void detail.load();
        });
      }
      if (state.capabilities?.features.webPlayback && !playerRequested) {
        playerRequested = true;
        void context.client
          .playerCore()
          .then((core) => {
            if (!disposed) playerCore = core;
          })
          .catch(() => {});
      }
    }),
  );
  let lastNavigation = '';
  $effect(() => {
    const selected = scope;
    const root = rootId;
    const intent = rootIntent;
    const navigation = JSON.stringify([selected, root, intent]);
    untrack(() => {
      if (navigation === lastNavigation) return;
      if (JSON.stringify(selected) !== JSON.stringify(get(browser).scope)) {
        bulk.reset();
        bulkOpen = false;
      }
      lastNavigation = navigation;
      addingFolder = false;
      addingFolderBusy = false;
      folderSelectionFailure = null;
      folderAdder?.dispose();
      folderAdder = null;
      upload = false;
      void browser.selectScope(selected);
      void browser.setQuery({ rootId: root });
    });
  });
  let folderGeneration = 0;
  let folderRejected = false;
  let folderFailure = $state<string | null>(null);
  let folderRetry = $state(0);
  let lastFolderRequest = '';
  let lastFolderScope = '';
  $effect(() => {
    const selected = scope;
    const allowed = owner;
    const signal = $application.invalidation;
    const retry = folderRetry;
    const scopeKey = JSON.stringify(selected);
    const requestKey = JSON.stringify([selected, allowed, signal, retry]);
    untrack(() => {
      if (requestKey === lastFolderRequest) return;
      lastFolderRequest = requestKey;
      const run = ++folderGeneration;
      if (scopeKey !== lastFolderScope || !allowed) {
        folders = [];
        folderRejected = false;
        folderFailure = null;
        lastFolderScope = scopeKey;
      }
      if (!selected || !allowed || folderRejected || disposed) return;
      void context.client
        .rootSummaries(selected)
        .then((result) => {
          if (disposed || run !== folderGeneration) return;
          folders = result.items;
          folderFailure = null;
          const filter = get(browser).filters.rootId;
          if (filter && !result.items.some((summary) => summary.root.id === filter))
            void browser.setQuery({ rootId: '' });
        })
        .catch((error) => {
          if (disposed || run !== folderGeneration) return;
          folderFailure = explain(error);
          if (isUnauthorized(error) || isForbidden(error)) {
            folderGeneration++;
            folders = [];
            folderRejected = true;
            if (isUnauthorized(error)) rejectAccess(401);
            else void application.revalidate();
          }
        });
    });
  });
  function refreshCollection() {
    folderRejected = false;
    folderRetry++;
    void browser.refresh({ restart: get(browser).requiresRefresh });
  }
  async function refreshDetails() {
    const opened = detail;
    await browser.refresh({ restart: get(browser).requiresRefresh });
    // Changed browse metadata already creates and loads a fresh detail instance.
    if (!disposed && detail === opened) await detail?.load();
  }
  const title = $derived(
    scope && 'libraryId' in scope
      ? (libraries.find((library) => library.id === scope.libraryId)?.name ?? 'Library')
      : scope
        ? 'Unassigned folders'
        : 'Your libraries',
  );
  const canCreate = $derived(
    scope &&
      'libraryId' in scope &&
      libraries.some((library) => library.id === scope.libraryId && library.canCreateItems),
  );
  function open(entry: LibraryBrowseEntry) {
    browser.open(entry, {
      scrollTop: window.scrollY,
      focusKey: entryKey(entry),
    });
    void tick().then(() => region?.querySelector<HTMLElement>('[data-detail-heading]')?.focus());
  }
  async function back() {
    const saved = browser.back();
    await tick();
    if (disposed) return;
    const button = Array.from(region.querySelectorAll<HTMLElement>('[data-entry-key]')).find(
      (element) => element.dataset.entryKey === saved?.focusKey,
    );
    button?.focus({ preventScroll: true });
    window.scrollTo(0, saved?.scrollTop ?? 0);
  }
  onMount(() => {
    void context.client
      .systems()
      .then((result) => {
        if (!disposed) systems = result.systems;
      })
      .catch(() => {});
  });
  onDestroy(() => {
    unsubscribeApplication();
    unsubscribeBrowser();
    disposePrivate();
  });
</script>

<div bind:this={region} class="library-region">
  {#if !scope}<header class="page-heading">
      <div>
        <p class="eyebrow">Library</p>
        <h1>Your libraries</h1>
        <p class="dim">Choose a library in the navigation to browse games and their files.</p>
      </div>
    </header>
    {#if !libraries.length}<p>No libraries are available to this account.</p>{/if}
  {:else if detail}<LibraryDetail
      controller={detail}
      onauthorization={rejectUploadAccess}
      selectedSource={$browser.active?.source??null}
      {owner}
      {context}
      {playerCore}
      refreshing={$browser.loading}
      onrefresh={() => void refreshDetails()}
      onback={() => void back()}
      onchanged={() => {
        void browser.refresh();
      }}
    />
  {:else}
    <header class="page-heading">
      <div>
        <p class="eyebrow">Library</p>
        <h1>{title}</h1>
      </div>
      <div class="actions" role="group" aria-label="Add content and library actions">
        {#if owner}<button type="button" onclick={() => (bulkOpen = true)}>{['discovering','running'].includes($bulk.phase) ? 'Matching library…' : $bulk.phase==='idle' ? 'Match library' : 'Matching results'}</button>{/if}
        {#if canCreate}<button type="button" onclick={() => { uploadMode='files'; upload=true; }}>
            Upload files
          </button><button type="button" onclick={() => { uploadMode='folder'; upload=true; }}>Upload folder</button>{/if}{#if owner && scope && 'libraryId' in scope}<button type="button" disabled={addingFolderBusy || $folderAdder?.busy} onclick={() => void addServerFolder()}>Add server folder</button>{/if}{#if owner}<button type="button" onclick={onsettings}>
            Library settings
          </button>{/if}
        <button
          type="button"
          disabled={$browser.loading}
          onclick={() => {
            refreshCollection();
          }}
        >
          Refresh
        </button>
      </div>
    </header>
    <CategoryTabs
      selected={$browser.filters.category}
      onchange={(category) => {
        void browser.setQuery({ category });
      }}
    />
    {#if folderFailure}<p class="problem" role="alert">{folderFailure}</p>{/if}
    <CollectionToolbar
      filters={$browser.filters}
      systemCounts={$browser.systemCounts}
      {systems}
      {folders}
      onchange={(patch) => {
        void browser.setQuery(patch);
      }}
    />
    <div
      id="collection-panel"
      role="tabpanel"
      aria-labelledby={`category-${$browser.filters.category}`}
      aria-busy={$browser.loading}
    >
      <ViewState
        loading={$browser.loading}
        failure={$browser.failure}
        empty={$browser.items.length === 0}
        filtered={!!(
          $browser.filters.search ||
          $browser.filters.systemId ||
          $browser.filters.systemIds.length ||
          $browser.filters.rootId
        )}
      />
      {#if $browser.requiresRefresh}<p>
          The saved page is no longer valid. Use Refresh to return to the first page with these
          filters.
        </p>{/if}
      <CollectionPage
        items={$browser.items}
        {systems}
        urls={$previews.urls}
        grid={$browser.filters.view === 'grid' && $browser.filters.category === 'games'}
        onopen={open}
      />
    </div>
    <nav class="pagination" aria-label="Collection pages">
      <button
        type="button"
        aria-label="Previous page"
        disabled={!$browser.hasPrevious || $browser.loading}
        onclick={() => {
          void browser.previous();
        }}
      >
        Previous
      </button>
      <span>Page {$browser.page}</span>
      <button
        type="button"
        aria-label="Next page"
        disabled={!$browser.hasNext || $browser.loading}
        onclick={() => {
          void browser.next();
        }}
      >
        Next
      </button>
    </nav>
  {/if}
  {#if folderAdder && owner && scope && 'libraryId' in scope}
    {#each Object.entries($folderAdder?.scanFailures??{}) as [id,message]}<p class="problem" role="alert">Folder saved. Scan failed: {message} <button type="button" onclick={()=>void folderAdder?.retryScan(id)}>Retry scan</button></p>{/each}
    {#if owner && !addingFolder && (folderSelectionFailure || $folderAdder?.failure)}<p class="problem" role="alert">{folderSelectionFailure || $folderAdder?.failure}</p>{/if}
    {#if addingFolder && owner}<Modal title="Add server folder" busy={addingFolderBusy || $folderAdder?.busy} onclose={()=>addingFolder=false}>
      <FolderPicker client={context.client} contextKey={context.key} origin={context.origin} title="Add server folder" submitLabel="Add folder" onbusy={busy=>addingFolderBusy=busy} oncancel={()=>addingFolder=false} onsubmit={async selection=>{if(!folderAdder)return false;const saved=await folderAdder.add(selection);if(!saved)throw new Error(get(folderAdder).failure??'Folder could not be added.');return true;}} />
    </Modal>{/if}
  {/if}
  {#if bulkOpen && owner && scope}<Modal title="Match library" onclose={() => { bulkOpen = false; refreshCollection(); }}>
    <BulkMatching {context} controller={bulk} {scope} onchanged={refreshCollection} />
  </Modal>{/if}
  {#if upload && canCreate && scope && 'libraryId' in scope}<Modal
      title="Upload files"
      busy={uploading}
      onclose={() => (upload = false)}
    >
      <Upload
        onbusy={(busy) => (uploading = busy)}
        client={context.client}
        libraryId={scope.libraryId}
        item={null}
        mode={uploadMode}
        category={$browser.filters.category}
        onauthorization={rejectUploadAccess}
        oncomplete={() => {
          void browser.refresh();
        }}
      />
    </Modal>{/if}
</div>
