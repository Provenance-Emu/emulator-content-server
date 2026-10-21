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
  import { explain, isForbidden, isUnauthorized } from './lib/problems';
  import { entryKey } from './lib/content-format';
  import CategoryTabs from './components/CategoryTabs.svelte';
  import CollectionToolbar from './components/CollectionToolbar.svelte';
  import CollectionPage from './components/CollectionPage.svelte';
  import ViewState from './components/ViewState.svelte';
  import Modal from './components/Modal.svelte';
  import LibraryDetail from './LibraryDetail.svelte';
  import Upload from './Upload.svelte';
  let {
    context,
    application,
    scope,
    rootId = '',
    rootIntent = 0,
    owner,
    libraries,
    onsettings,
  }: {
    context: ServerContext;
    application: ApplicationController;
    scope: LibraryScope | null;
    rootId?: string;
    rootIntent?: number;
    owner: boolean;
    libraries: Library[];
    onsettings: () => void;
  } = $props();
  const browser = untrack(() => createLibraryBrowser(context.client, null));
  const authEpoch = untrack(() => get(application).authEpoch);
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
  let uploading = $state(false);
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
      const selected = get(browser).scope;
      if (
        selected &&
        ('libraryId' in selected
          ? !state.libraries.some((library) => library.id === selected.libraryId)
          : !state.owner)
      ) {
        clearDetail();
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
      lastNavigation = navigation;
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
      {owner}
      {context}
      {playerCore}
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
      <div class="actions">
        {#if canCreate}<button type="button" onclick={() => (upload = true)}>
            Upload files
          </button>{/if}{#if owner}<button type="button" onclick={onsettings}>
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
        oncomplete={() => {
          upload = false;
          void browser.refresh();
        }}
      />
    </Modal>{/if}
</div>
