<script lang="ts">
  import LibraryTiles from './components/LibraryTiles.svelte';
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
  import { shownLabel } from './lib/batches';
  import { createLibraryBrowser } from './lib/library-browser';
  import { createDetail, type DetailController } from './lib/detail';
  import { createPreviews } from './lib/previews';
  import { explain, isForbidden, isUnauthorized } from './lib/problems';
  import { entryKey } from './lib/content-format';
  import CategoryTabs from './components/CategoryTabs.svelte';
  import CollectionToolbar from './components/CollectionToolbar.svelte';
  import { noteSystem } from './lib/system-order';
  import CollectionPage from './components/CollectionPage.svelte';
  import ListMore from './components/ListMore.svelte';
  import ViewState from './components/ViewState.svelte';
  import Modal from './components/Modal.svelte';
  import LibraryDetail from './LibraryDetail.svelte';
  import UnassignedFolders from './UnassignedFolders.svelte';
  import Upload from './Upload.svelte';
  import FolderPicker from './FolderPicker.svelte';
  import {createLibraryFolders} from './lib/library-folders';
  import { chooseFolder, type FolderContext, type FolderSelection } from './lib/folder-selection';
  import LibraryJobs from './LibraryJobs.svelte';
  import type { SettingsDestination } from './lib/shell-navigation';
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
    onpairdevice,
  }: {
    context: ServerContext;
    application: ApplicationController;
    folderContext: FolderContext;
    scope: LibraryScope | null;
    rootId?: string;
    rootIntent?: number;
    owner: boolean;
    libraries: Library[];
    onsettings: (destination?: SettingsDestination) => void;
    onchoose: (scope: LibraryScope) => void;
    oncreate: () => void;
    onpairdevice: () => void;
  } = $props();
  const browser = untrack(() => createLibraryBrowser(context.client, null));
  const authEpoch = untrack(() => get(application).authEpoch);
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
  let preselected = $state<FolderSelection | null>(null);
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
    preselected = null;
    if (!folderContext.folderSelection) { addingFolder = true; return; }
    addingFolderBusy = true;
    try {
      const selected = await chooseFolder(folderContext, 'library-folder');
      if (selected && !disposed && folderAdder === adder) { preselected = selected; addingFolder = true; }
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
  const unsubscribeBrowser = browser.subscribe((state) => {
    if (disposed) return;
    if (state.status === 401) {
      rejectAccess(401);
      return;
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
      if (!state.owner && bulkOpen) {
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
        bulkOpen = false;
      }
      lastNavigation = navigation;
      addingFolder = false;
      preselected = null;
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
  /** The server counts each system before a system is chosen; add up the ones in view. */
  const total = $derived(
    $browser.systemCounts
      .filter(
        (row) =>
          (!$browser.filters.systemIds.length || $browser.filters.systemIds.includes(row.systemId)) &&
          (!$browser.filters.systemId || $browser.filters.systemId === row.systemId),
      )
      .reduce((sum, row) => sum + row.count, 0),
  );
  const shown = $derived(
    shownLabel(
      $browser.items.length,
      $browser.hasMore,
      $browser.filters.category === 'games' ? ['game', 'games'] : ['file', 'files'],
      total,
    ),
  );
  const canCreate = $derived(
    scope &&
      'libraryId' in scope &&
      libraries.some((library) => library.id === scope.libraryId && library.canCreateItems),
  );
  const filtered = $derived(!!($browser.filters.search || $browser.filters.systemId || $browser.filters.systemIds.length || $browser.filters.rootId));
  const canAdd = $derived(!!(canCreate || (owner && scope && 'libraryId' in scope)));
  /** Marks the browser-history entry that stands for an open game. */
  const GAME_STATE = 'ecsGame';
  const gameInHistory = (): string | null =>
    (window.history.state as Record<string, unknown> | null)?.[GAME_STATE]?.toString() ?? null;
  /** Where the list was when the first game was opened, kept while stepping between games. */
  let listScroll = 0;
  /**
   * Opens a game. Coming from the list it becomes a step in the browser's history, so Back
   * returns to the list. Stepping to a neighbour replaces that step, so Back still does.
   */
  function open(entry: LibraryBrowseEntry, record: 'push' | 'replace' | 'none' = 'push') {
    if (record === 'push') {
      listScroll = window.scrollY;
      // The systems someone opens games from lead the filter row next time.
      noteSystem(entry.systemId);
    }
    browser.open(entry, { scrollTop: listScroll, focusKey: entryKey(entry) });
    const state = { ...(window.history.state as object | null), [GAME_STATE]: entryKey(entry) };
    if (record === 'push') window.history.pushState(state, '');
    else if (record === 'replace') window.history.replaceState(state, '');
    void tick().then(() => region?.querySelector<HTMLElement>('[data-detail-heading]')?.focus());
  }
  /** The games before and after the open one, in the list it was opened from. */
  const neighbours = $derived.by(() => {
    const active = $browser.active;
    if (!active) return { previous: null, next: null };
    const games = $browser.items;
    const at = games.findIndex((entry) => entryKey(entry) === entryKey(active));
    return {
      previous: at > 0 ? (games[at - 1] ?? null) : null,
      next: at >= 0 ? (games[at + 1] ?? null) : null,
    };
  });
  function step(entry: LibraryBrowseEntry | null) {
    if (entry) open(entry, gameInHistory() ? 'replace' : 'push');
  }
  /** Leaving through the page's own button goes the same way the browser's Back does. */
  function leave() {
    if (gameInHistory()) window.history.back();
    else void back();
  }
  function moved() {
    if (disposed) return;
    const key = gameInHistory();
    const active = get(browser).active;
    if (!key) {
      if (active) void back();
      return;
    }
    if (active && entryKey(active) === key) return;
    // Forward to a game: reopen it when it is still in the list, without a new history step.
    const entry = get(browser).items.find((candidate) => entryKey(candidate) === key);
    if (entry) open(entry, 'none');
    else if (active) void back();
  }
  function arrows(event: KeyboardEvent) {
    if (!get(browser).active || event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target as HTMLElement | null;
    // Arrow keys belong to whatever is being typed in, chosen from, or shown in a dialog.
    if (target?.closest('input, textarea, select, [contenteditable], [role="slider"], dialog, [role="dialog"], [role="radiogroup"], [role="tablist"], [role="menu"]'))
      return;
    if (document.querySelector('dialog[open]')) return;
    const entry = event.key === 'ArrowLeft' ? neighbours.previous : neighbours.next;
    if (!entry) return;
    event.preventDefault();
    step(entry);
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
    window.addEventListener('popstate', moved);
    window.addEventListener('keydown', arrows);
    return () => {
      window.removeEventListener('popstate', moved);
      window.removeEventListener('keydown', arrows);
    };
  });
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
          <h1>{libraries.length || !owner ? 'Your libraries' : 'Welcome to your game library'}</h1>
          <p class="dim">{libraries.length ? 'Choose a library to browse, play or manage your games.' : 'Create a library, add your games, then play or download them.'}</p>
        </div>
        {#if owner}<div class="actions">
          <button type="button" onclick={onpairdevice}>Pair a device</button>
          <button class="primary" type="button" onclick={oncreate}>{libraries.length ? 'Create a library' : 'Create your first library'}</button>
        </div>{/if}
      </header>
      {#if owner && !libraries.length}<UnassignedFolders client={context.client} context={folderContext} {libraries} invalidation={$application.invalidation} onview={(_,id)=>{if(id)onchoose({libraryId:id});}} />{/if}
      {#if libraries.length}
        <LibraryTiles client={context.client} {libraries} invalidation={$application.invalidation}
          onchoose={(libraryId) => onchoose({ libraryId })} onsignedout={() => rejectAccess(401)} />
        {#if owner}<details class="home-management"><summary>Unassigned folders</summary><UnassignedFolders client={context.client} context={folderContext} {libraries} invalidation={$application.invalidation} onview={(_,id)=>{if(id)onchoose({libraryId:id});}} /></details>{/if}
      {:else if owner}
        <ol class="welcome-steps">
          <li><strong>Create a library</strong><p>Give your collection a name. You can change it later.</p></li>
          <li><strong>Add your games</strong><p>Upload files from this device, or choose a folder on the server computer. We don't supply game files.</p></li>
          <li><strong>Play or download</strong><p>Open a game for Play when supported, or Download to use it in your emulator.</p></li>
        </ol>
      {:else}<div class="empty-state"><h2>No libraries shared yet</h2><p>Ask the person who runs this server to give your account access to a library. Shared libraries will appear here.</p></div>{/if}
    </section>
  {:else if detail}<LibraryDetail
    onemulators={owner ? () => onsettings({ section: 'emulators' }) : undefined}
      controller={detail}
      onauthorization={rejectUploadAccess}
      selectedSource={$browser.active?.source??null}
      gameCompanions={$application.capabilities?.features.gameCompanions === true}
      {owner}
      canEdit={owner || libraries.some((library) => library.id === $browser.active?.source?.libraryId && library.canCreateItems)}
      {context}
      {playerCore}
      {systems}
      refreshing={$browser.loading}
      onrefresh={() => void refreshDetails()}
      onback={leave}
      previous={neighbours.previous ? { name: neighbours.previous.name, go: () => step(neighbours.previous) } : null}
      next={neighbours.next ? { name: neighbours.next.name, go: () => step(neighbours.next) } : null}
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
          <summary aria-label="Manage library">Manage</summary>
          <div class="library-management-actions">
            {#if owner}
              <button type="button" onclick={() => onsettings({ section: 'libraries', libraryId: scope && 'libraryId' in scope ? scope.libraryId : undefined })}>Library settings</button>
              <button type="button" onclick={() => (bulkOpen = true)}>Library activity</button>{/if}
            <button type="button" disabled={$browser.loading} onclick={refreshCollection}>Refresh</button>
          </div>
        </details>
      </div>
    </header>
    {#if owner && !$browser.loading && !$browser.items.length && !filtered}<UnassignedFolders client={context.client} context={folderContext} {libraries} preferredLibraryId={scope && 'libraryId' in scope ? scope.libraryId : ''} invalidation={$application.invalidation} onview={(_,id)=>{if(id)onchoose({libraryId:id});}} />{/if}
    {#if owner && folders.some(row=>!row.lastScanAt) && scope && 'libraryId' in scope}
      <section class="scan-needed" aria-label="Folders waiting for a file check"><h2>Waiting for the first file check</h2><p>The server checks added folders and looks up details and covers separately. Check files now if the folder was added with automatic work disabled.</p><button type="button" disabled={!!$folderAdder?.busy} onclick={()=>void scanSavedFolders()}>{$folderAdder?.busy ? 'Checking files…' : 'Check files now'}</button></section>
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
        unassigned={!!scope && 'unassigned' in scope}
      />
      {#if !$browser.loading && !$browser.failure && !$browser.items.length && !filtered && canAdd}
        <button class="primary" type="button" onclick={() => (addChoices = true)}>{$browser.filters.category === 'games' ? 'Add your first game' : 'Add your first file'}</button>
      {/if}
      {#if $browser.requiresRefresh}<p>
          This list changed on the server.
          <button type="button" onclick={refreshCollection}>Load it again</button>
        </p>{/if}
      <CollectionPage
        items={$browser.items}
        {systems}
        urls={$previews.urls}
        grid={$browser.filters.view === 'grid' && $browser.filters.category === 'games'}
        onopen={open}
        onvisible={(entries) => void previews.request(entries)}
      />
    </div>
    {#if $browser.items.length}<ListMore
        label={shown}
        more={$browser.hasMore}
        busy={$browser.loading || $browser.loadingMore}
        failed={!!$browser.failure}
        auto={!$browser.requiresRefresh}
        announce
        onmore={() => void browser.more()}
      />{/if}
  {/if}
  {#if folderAdder && owner && scope && 'libraryId' in scope}
    {#each Object.entries($folderAdder?.scanFailures??{}) as [id,message]}<p class="problem" role="alert">Folder saved. Scan failed: {message} <button type="button" onclick={()=>void folderAdder?.retryScan(id)}>Retry scan</button></p>{/each}
    {#if !addingFolder && $folderAdder?.existingRoot}<div><p>This folder is already saved. Link it to {title} and scan its games?</p><button type="button" disabled={!!$folderAdder?.busy} onclick={()=>void folderAdder?.linkExisting()}>Use existing folder</button></div>{/if}
    {#if $folderAdder?.notice}<p role="status">{$folderAdder.notice}</p>{/if}
    {#if owner && !addingFolder && (folderSelectionFailure || $folderAdder?.failure)}<p class="problem" role="alert">{folderSelectionFailure || $folderAdder?.failure}</p>{/if}
  {/if}
  {#if bulkOpen && owner && scope}<Modal title="Library activity" onclose={() => { bulkOpen = false; refreshCollection(); }}>
    <LibraryJobs {context} {scope} {libraries} roots={folders} onchanged={refreshCollection} />
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
      {:else if addingFolder && owner}<FolderPicker client={context.client} contextKey={context.key} origin={context.origin} title="Add server folder" submitLabel="Add folder" libraryFolder {preselected} onbusy={busy=>addingFolderBusy=busy} oncancel={()=>{addingFolder=false;addChoices=false;}} onsubmit={async selection=>{if(!folderAdder)return false;const saved=await folderAdder.add(selection);if(!saved)throw new Error(get(folderAdder).failure??'Folder could not be added.');return true;}} />
      {:else}<p>Where are the files you want to add?</p>
        <div class="add-games-options">
          {#if canCreate}
            <section class="add-games-option"><h3>On this device</h3><p>Copy game files from your phone or computer into this library. Choose the system before uploading.</p>
              <div class="actions"><button class="primary" type="button" onclick={() => { uploadMode='files';upload=true;addChoices=false; }}>Upload files</button>
              <button type="button" onclick={() => { uploadMode='folder';upload=true;addChoices=false; }}>Upload folder</button></div>
            </section>
          {/if}
          {#if owner}<section class="add-games-option"><h3>Already on the server</h3><p>Register a server folder and choose watching and organization options. Metadata and artwork fill in automatically.</p><button type="button" onclick={() => { void addServerFolder(); addChoices=false; }}>Add server folder</button></section>{/if}
        </div>
      {/if}
      {#if addingFolder && $folderAdder?.existingRoot}<div class="existing-folder-link"><p>This folder is already registered. Add it to {title} and scan its files?</p><button type="button" disabled={!!$folderAdder?.busy} onclick={async()=>{if(await folderAdder?.linkExisting())addingFolder=false;}}>Use existing folder</button></div>{/if}
    </Modal>{/if}
</div>
