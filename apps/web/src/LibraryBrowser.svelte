<script lang="ts">
  import { ContentError } from '@ecs/client';
  import type {
    ContentRootSummary,
    Library,
    LibraryBrowseEntry,
    LibraryScope,
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
  import UnassignedFolders from './UnassignedFolders.svelte';
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
    onchoose,
    oncreate,
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
    onchoose: (scope: LibraryScope) => void;
    oncreate: () => void;
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
  let playerCore = $state<import('./player/links').PlayableCores>(null);
  let playerRequested = false;
  let addChoices = $state(false);
  let upload = $state(false);
  let uploadMode = $state<'files'|'folder'>('files');
  let uploading = $state(false);
  let folderAdder = $state.raw<ReturnType<typeof createLibraryFolders>|null>(null);
  let addingFolder = $state(false);
  let addingFolderBusy = $state(false);
  let folderSelectionFailure = $state<string | null>(null);
  function folderController() {
    if (!scope || !('libraryId' in scope) || !owner || addingFolderBusy || (folderAdder && get(folderAdder).busy)) return null;
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
    adder.receive(folders);
    return adder;
  }
  async function scanSavedFolders() {
    const adder = folderController();
    if (adder) await adder.scanLibrary();
  }
  async function addServerFolder() {
    const adder = folderController();
    if (!adder) return;
    if (!folderContext.folderSelection) { addingFolder = true; return; }
    addingFolderBusy = true;
    try {
      const selected = await chooseFolder(folderContext, 'library-folder');
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
    addChoices = false;
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
          .playerProfiles()
          .then((profiles) => {
            if (!disposed) playerCore = profiles.items;
          })
          .catch(async(error) => { if(error instanceof ContentError && error.status===404) { try { const core=await context.client.playerCore(); if(!disposed)playerCore=core; } catch {} } });
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
      addChoices = false;
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
  const filtered = $derived(!!($browser.filters.search || $browser.filters.systemId || $browser.filters.systemIds.length || $browser.filters.rootId));
  const canAdd = $derived(!!(canCreate || (owner && scope && 'libraryId' in scope)));
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
  {#if !scope}<section class="library-home">
      <header class="page-heading">
        <div>
          <p class="eyebrow">Your collection, together</p>
          <h1>{libraries.length || !owner ? 'Your libraries' : 'Welcome to your game library'}</h1>
          <p class="dim">Keep your games in one place. Open a library to play supported games in your browser, download files, or use them in your emulator.</p>
        </div>
        {#if owner}<button class="primary" type="button" onclick={oncreate}>{libraries.length ? 'Create a library' : 'Create your first library'}</button>{/if}
      </header>
      {#if owner}<UnassignedFolders client={context.client} context={folderContext} {libraries} invalidation={$application.invalidation} onview={(_,id)=>{if(id)onchoose({libraryId:id});}} />{/if}
      {#if libraries.length}
        <div class="library-choice-grid" aria-label="Choose a library">
          {#each libraries as library (library.id)}
            <button type="button" class="library-choice" aria-label={`Open library ${library.name}`} onclick={() => onchoose({ libraryId: library.id })}>
              <span class="eyebrow">Game library</span><strong>{library.name}</strong><span>Open library →</span>
            </button>
          {/each}
        </div>
        {#if owner}<p class="dim">A library is a collection you name, such as “My games” or “Family favorites”. You choose who can access it in Settings.</p>{/if}
      {:else if owner}
        <ol class="welcome-steps">
          <li><strong>Create a library</strong><p>Give your collection a name. You can change it later.</p></li>
          <li><strong>Add your games</strong><p>Upload files from this device, or choose a folder on the server computer. We don't supply game files.</p></li>
          <li><strong>Play or download</strong><p>Open a game for Play when supported, or Download to use it in your emulator.</p></li>
        </ol>
      {:else}<div class="empty-state"><h2>No libraries shared yet</h2><p>Ask the person who runs this server to give your account access to a library. Shared libraries will appear here.</p></div>{/if}
    </section>
  {:else if detail}<LibraryDetail
      controller={detail}
      onauthorization={rejectUploadAccess}
      selectedSource={$browser.active?.source??null}
      {owner}
      {context}
      {playerCore}
      {systems}
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
      <div class="actions" role="group" aria-label="Library actions">
        {#if canAdd}<button class="primary" type="button" disabled={addingFolderBusy || $folderAdder?.busy} onclick={() => (addChoices = true)}>{$browser.filters.category === 'games' ? 'Add games' : 'Add files'}</button>{/if}
        <details class="library-tools">
          <summary>Library tools</summary>
          <div class="actions">
            {#if owner}<button type="button" onclick={() => (bulkOpen = true)}>{['discovering','running'].includes($bulk.phase) ? 'Matching library…' : $bulk.phase==='idle' ? 'Match library' : 'Matching results'}</button>
              <button type="button" disabled={!folders.length || !!$folderAdder?.busy} onclick={()=>void scanSavedFolders()}>Scan folders for games</button>
              <button type="button" onclick={onsettings}>Library settings</button>{/if}
            <button type="button" disabled={$browser.loading} onclick={refreshCollection}>Refresh</button>
          </div>
        </details>
      </div>
    </header>
    {#if owner && !$browser.loading && !$browser.items.length && !filtered}<UnassignedFolders client={context.client} context={folderContext} {libraries} preferredLibraryId={scope && 'libraryId' in scope ? scope.libraryId : ''} invalidation={$application.invalidation} onview={(_,id)=>{if(id)onchoose({libraryId:id});}} />{/if}
    {#if owner && folders.some(row=>!row.lastScanAt) && scope && 'libraryId' in scope}
      <section class="scan-needed" aria-label="Saved folders need scanning"><h2>Your saved folders need a scan</h2><p>Scan these folders to show their games in this library. Files stay in place. Artwork and game details can be found afterwards with Match library.</p><button type="button" disabled={!!$folderAdder?.busy} onclick={()=>void scanSavedFolders()}>{$folderAdder?.busy ? 'Scanning folders…' : 'Scan saved folders'}</button></section>
    {/if}
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
        {filtered}
        canAdd={canAdd}
      />
      {#if !$browser.loading && !$browser.failure && !$browser.items.length && !filtered && canAdd}
        <button class="primary" type="button" onclick={() => (addChoices = true)}>{$browser.filters.category === 'games' ? 'Add your first game' : 'Add your first file'}</button>
      {/if}
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
    {#if $browser.items.length || $browser.hasPrevious || $browser.hasNext}<nav class="pagination" aria-label="Collection pages">
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
    </nav>{/if}
  {/if}
  {#if folderAdder && owner && scope && 'libraryId' in scope}
    {#each Object.entries($folderAdder?.scanFailures??{}) as [id,message]}<p class="problem" role="alert">Folder saved. Scan failed: {message} <button type="button" onclick={()=>void folderAdder?.retryScan(id)}>Retry scan</button></p>{/each}
    {#if !addingFolder && $folderAdder?.existingRoot}<div><p>This folder is already saved. Link it to {title} and scan its games?</p><button type="button" disabled={!!$folderAdder?.busy} onclick={()=>void folderAdder?.linkExisting()}>Use existing folder</button></div>{/if}
    {#if $folderAdder?.notice}<p role="status">{$folderAdder.notice}</p>{/if}
    {#if owner && !addingFolder && (folderSelectionFailure || $folderAdder?.failure)}<p class="problem" role="alert">{folderSelectionFailure || $folderAdder?.failure}</p>{/if}
  {/if}
  {#if bulkOpen && owner && scope}<Modal title="Match library" onclose={() => { bulkOpen = false; refreshCollection(); }}>
    <BulkMatching {context} controller={bulk} {scope} onchanged={refreshCollection} />
  </Modal>{/if}
  {#if scope && 'libraryId' in scope && ((addChoices && canAdd) || (upload && canCreate) || (addingFolder && owner))}<Modal
      title={upload ? 'Upload files' : addingFolder ? 'Add server folder' : $browser.filters.category === 'games' ? 'Add games' : 'Add files'}
      busy={uploading || addingFolderBusy || !!$folderAdder?.busy}
      onclose={() => { addChoices = false; upload = false; addingFolder = false; }}
    >
      {#if upload && canCreate}<Upload
        serverContext={context}
        onbusy={(busy) => (uploading = busy)}
        client={context.client}
        libraryId={scope.libraryId}
        item={null}
        mode={uploadMode}
        category={$browser.filters.category}
        onauthorization={rejectUploadAccess}
        oncomplete={() => { void browser.refresh(); }}
      />
      {:else if addingFolder && owner}<FolderPicker client={context.client} contextKey={context.key} origin={context.origin} title="Add server folder" submitLabel="Add folder" onbusy={busy=>addingFolderBusy=busy} oncancel={()=>{addingFolder=false;addChoices=false;}} onsubmit={async selection=>{if(!folderAdder)return false;const saved=await folderAdder.add(selection);if(!saved)throw new Error(get(folderAdder).failure??'Folder could not be added.');return true;}} />
      {:else}<p>Where are the files you want to add?</p>
        <div class="add-games-options">
          {#if canCreate}
            <section class="add-games-option"><h3>On this device</h3><p>Copy game files from your phone or computer into this library. Choose the system before uploading.</p>
              <div class="actions"><button class="primary" type="button" onclick={() => { uploadMode='files';upload=true;addChoices=false; }}>Upload files</button>
              <button type="button" onclick={() => { uploadMode='folder';upload=true;addChoices=false; }}>Upload folder</button></div>
            </section>
          {/if}
          {#if owner}<section class="add-games-option"><h3>Already on the server</h3><p>Files stay on the server computer. Nothing is copied.</p><button type="button" onclick={() => { void addServerFolder(); addChoices=false; }}>Add server folder</button></section>{/if}
        </div>
      {/if}
      {#if addingFolder && $folderAdder?.existingRoot}<div class="existing-folder-link"><p>This folder is already registered. Add it to {title} and scan its files?</p><button type="button" disabled={!!$folderAdder?.busy} onclick={async()=>{if(await folderAdder?.linkExisting())addingFolder=false;}}>Use existing folder</button></div>{/if}
    </Modal>{/if}
</div>
