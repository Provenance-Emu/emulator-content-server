<script lang="ts">
  import type { Library, LibraryScope } from '@ecs/client';
  import { get } from 'svelte/store';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { createApplication, type ApplicationState, type ServerContext } from './lib/application';
  import { createServerUpdates } from './lib/server-updates';
  import type { FolderContext, FolderSelectionAdapter } from './lib/folder-selection';
  import {
    readShellLocation, shellLocationSearch,
    type ShellLocation, type SettingsDestination, type SettingsSection,
  } from './lib/shell-navigation';
  import LibraryEditor from './LibraryEditor.svelte';
  import Login from './Login.svelte';
  import LibraryBrowser from './LibraryBrowser.svelte';
  import SetupGuide from './SetupGuide.svelte';
  import { readSetupProgress, type SetupMode } from './lib/setup-progress';
  import SettingsShell from './SettingsShell.svelte';
  import ServerUpdatePrompt from './ServerUpdatePrompt.svelte';
  import Modal from './components/Modal.svelte';
  let {
    context,
    folderSelection,
    setupCode,
    revealSetupCode,
    setupGuide, onsetupclose, onchoosecomputer,
  }: { context: ServerContext; folderSelection?: FolderSelectionAdapter; setupCode?: string; revealSetupCode?: () => Promise<void>; setupGuide?: SetupMode; onsetupclose?: () => void; onchoosecomputer?: () => void } = $props();
  const application = untrack(() => createApplication(context));
  const updates = untrack(() => createServerUpdates(context.client));
  const updateAccess = $derived($application.owner && $application.hasSession ? $application.authEpoch : null);
  $effect(() => {
    if (updateAccess !== null) return updates.start();
  });
  let guide = $state<SetupMode | null>(untrack(() => setupGuide ?? null));
  let checkedSetup = false;
  $effect(() => {
    if (!checkedSetup && $application.settled && $application.reachable && $application.capabilities) {
      checkedSetup = true;
      const saved = readSetupProgress(context.origin);
      if ($application.capabilities.bootstrapped === false) guide = 'host';
      else if (!guide && saved && !saved.done && !saved.paused) guide = saved.mode;
    }
  });
  let scope = $state<LibraryScope | null>(null);
  let rootId = $state('');
  let rootIntent = $state(0);
  let settings = $state(false);
  let settingsSection = $state<SettingsSection>('libraries');
  let settingsLibraryId = $state('');
  let pendingLocation: ShellLocation | null = typeof window === 'undefined'
    ? null : readShellLocation(window.location.search);
  // Retain the scanned code through sign-in, including on a trusted LAN.
  const pairingFragment = typeof window === 'undefined' ? '' : window.location.hash.slice(1);
  let pairingPin = $state(new URLSearchParams(pairingFragment).get('pair') ?? '');
  let pairingOpened = false;
  let authenticated = false;
  let playerEpoch = $state(0);
  let drawer = $state(false);
  let signingIn = $state(false);
  let editing = $state<Library | null | undefined>(undefined);
  const unsubscribe = application.subscribe((state) => {
    if (!state.signedIn) {
      if (authenticated) pendingLocation = null;
      const wasAuthenticated = authenticated;
      authenticated = false;
      editing = undefined;
      scope = null;
      rootId = '';
      settings = false;
      settingsLibraryId = '';
      drawer = false;
      if (wasAuthenticated) recordLocation(true);
    } else {
      authenticated = true;
      if (pendingLocation) {
        applyLocation(pendingLocation, state);
        pendingLocation = null;
      }
      if (state.owner && !pairingOpened && /^[0-9]{6}$/.test(pairingPin)) {
        pairingOpened = true;
        settings = true;
        settingsSection = 'devices';
        recordLocation(true);
      }
      if (!state.owner) editing = undefined;
      const selected = scope;
      if (
        selected &&
        ('libraryId' in selected
          ? !state.libraries.some((library) => library.id === selected.libraryId)
          : !state.owner)
      ) {
        scope = null;
        rootId = '';
        recordLocation(true);
      }
      if (settingsLibraryId && !state.libraries.some(library => library.id === settingsLibraryId)) {
        settingsLibraryId = '';
      }
    }
  });
  function recordLocation(replace = false) {
    if (typeof window === 'undefined') return;
    const search = shellLocationSearch({
      libraryId: scope && 'libraryId' in scope ? scope.libraryId : '',
      unassigned: !!scope && 'unassigned' in scope,
      rootId,
      settings: settings ? settingsSection : null,
      settingsLibraryId,
    });
    const href = window.location.pathname + search;
    if (href === window.location.pathname + window.location.search && !window.location.hash) return;
    if (replace) window.history.replaceState(null, '', href);
    else window.history.pushState(null, '', href);
  }
  function applyLocation(location: ShellLocation, state: ApplicationState) {
    const libraryId = state.libraries.some(library => library.id === location.libraryId) ? location.libraryId : '';
    const unassigned = !libraryId && location.unassigned && state.owner;
    const nextRoot = libraryId || unassigned ? location.rootId : '';
    const previousLibrary = scope && 'libraryId' in scope ? scope.libraryId : '';
    if (previousLibrary !== libraryId || (!!scope && 'unassigned' in scope) !== unassigned || rootId !== nextRoot) {
      rootIntent++;
    }
    scope = libraryId ? { libraryId } : unassigned ? { unassigned: true } : null;
    rootId = nextRoot;
    settings = location.settings !== null;
    settingsSection = location.settings ?? 'libraries';
    if (!state.owner && settingsSection !== 'webdav') settingsSection = 'status';
    settingsLibraryId = state.libraries.some(library => library.id === location.settingsLibraryId) ? location.settingsLibraryId : '';
    drawer = false;
  }
  function openSettings(destination: SettingsDestination = { section: 'libraries' }) {
    settingsSection = destination.section;
    settingsLibraryId = destination.libraryId ?? '';
    settings = true;
    drawer = false;
    recordLocation();
  }
  function backToCollection() {
    settings = false;
    recordLocation();
  }
  function choose(next: LibraryScope | null) {
    rootIntent++;
    scope = next;
    rootId = '';
    settings = false;
    drawer = false;
    recordLocation();
  }
  function viewFolder(root: string, library: string | null) {
    rootIntent++;
    scope = library ? { libraryId: library } : { unassigned: true };
    rootId = root;
    settings = false;
    recordLocation();
  }
  function rejectOwnerSummary(status: 401 | 403, expectedEpoch: number) {
    if (get(application).authEpoch !== expectedEpoch) return;
    if (status === 401) void application.signOut();
    else void application.revalidate();
  }
  function actionContext(expectedEpoch: number): FolderContext {
    return {
      key: context.key, origin: context.origin, folderSelection,
      isCurrent: () => {
        const state = get(application);
        return state.authEpoch === expectedEpoch && state.signedIn && state.owner;
      },
      onrejected: (status) => rejectOwnerSummary(status, expectedEpoch),
      onchanged: async () => {
        await application.revalidate();
        const state = get(application);
        if (state.authEpoch === expectedEpoch && state.failure) throw new Error(`Change saved. ${state.failure}`);
      },
    };
  }
  onMount(() => {
    const restore = () => {
      const location = readShellLocation(window.location.search);
      const state = get(application);
      if (state.signedIn) applyLocation(location, state);
      else pendingLocation = location;
    };
    window.addEventListener('popstate', restore);
    void application.start();
    return () => window.removeEventListener('popstate', restore);
  });
  onDestroy(() => {
    unsubscribe();
    application.dispose();
  });
</script>

<a class="skip-link" href="#main-content">Skip to content</a>
{#if guide && $application.settled && $application.reachable && $application.capabilities}
  <SetupGuide {context} appState={$application} folderContext={actionContext($application.authEpoch)} mode={guide}
    {setupCode} {revealSetupCode} {onchoosecomputer}
    onsignin={(session, expectedEpoch) => { void application.adoptSession(session, expectedEpoch); }}
    onchange={async () => { await application.revalidate(); playerEpoch++; }}
    onrejected={status => rejectOwnerSummary(status, $application.authEpoch)}
    onclose={(id) => { guide = null; onsetupclose?.(); if (id) choose({ libraryId: id }); }}
    onsettings={section => { guide = null; onsetupclose?.(); openSettings({ section }); }}
  />
{:else}
<div class="application-shell" class:settings-active={settings}>
  <header class="mobile-header">
    {#if $application.signedIn}
      <button type="button" aria-label="Open navigation" onclick={() => (drawer = true)}>
        Menu
      </button>
    {/if}
    <span>{context.label}</span>
  </header>
  {#if $application.signedIn && !signingIn}
    <aside class="library-sidebar">{@render navigation()}</aside>
    {#if drawer}<Modal title="Library navigation" navigation onclose={() => (drawer = false)}>
        {@render navigation()}
      </Modal>{/if}
    <main id="main-content" tabindex="-1" class="application-content">
      {#if $application.owner && $application.hasSession}<ServerUpdatePrompt {updates} />{/if}
      {#if $application.localWarning}<p role="status" class="problem">{$application.localWarning}</p>{/if}
      {#if $application.failure}<p class="problem connection-message" role="status">
          {$application.failure}
        </p>{/if}
      {#key `${context.key}:${$application.authEpoch}`}
        {@const expectedEpoch = $application.authEpoch}
        <div hidden={settings}>
          {#key playerEpoch}<LibraryBrowser
            {context}
            {application}
            folderContext={actionContext(expectedEpoch)}
            {scope}
            {rootId}
            {rootIntent}
            owner={$application.owner}
            libraries={$application.libraries}
            onsettings={openSettings}
            onchoose={choose}
            oncreate={() => (editing = null)}
          />{/key}
        </div>
        {#if settings}<SettingsShell
            {updates}
            {pairingPin}
            onpaired={() => { pairingPin = ''; }}
            onsignin={() => { signingIn = true; drawer = false; }}
            onsetup={() => { guide = $application.owner ? 'host' : 'join'; }}
            onopendocumentation={context.openDocumentation}
            serverLabel={context.label}
            onplayerschange={async () => { await application.revalidate(); playerEpoch++; }}
            client={context.client}
            appState={$application}
            bind:selected={settingsSection}
            bind:libraryId={settingsLibraryId}
            onselect={() => recordLocation()}
            onlibrarychange={() => recordLocation(true)}
            onback={backToCollection}
            onview={viewFolder}
            onrejected={(status) => rejectOwnerSummary(status, expectedEpoch)}
            context={actionContext(expectedEpoch)}
            onrename={(library) => (editing = library)}
          />{/if}
        {#if $application.owner && editing !== undefined}<LibraryEditor
            client={context.client} context={actionContext(expectedEpoch)} library={editing ?? undefined}
            onclose={() => (editing = undefined)}
            oncomplete={(id) => {
              editing = undefined;
              if (get(application).libraries.some(library => library.id === id)) choose({ libraryId: id });
            }}
          />{/if}
      {/key}
    </main>
  {:else}<main id="main-content" tabindex="-1" class="login-content">
      {#if $application.localWarning}<p role="status" class="problem">{$application.localWarning}</p>{/if}
      <p class="eyebrow">{context.label}</p>
      <h1>Emulation Server</h1>
      {#if $application.settled && $application.reachable === false}
        <h2>Can't reach your library</h2>
        <p>The server is unreachable. Check that Emulation Server is running and that this device is connected to the same network, or check the server address.</p>
        <button class="primary" type="button" onclick={() => void application.revalidate()}>Try connecting again</button>
      {:else if $application.settled}{#key $application.authEpoch}{@const expectedEpoch =
            $application.authEpoch}<Login
            client={context.client}
            origin={context.origin}
            setup={$application.capabilities?.bootstrapped === false}
            {setupCode}
            {revealSetupCode}
            onsignin={(session) => {
              signingIn = false;
              void application.adoptSession(session, expectedEpoch);
            }}
          />{/key}{:else}<p role="status">Connecting to server…</p>{/if}
      {#if signingIn}<button type="button" onclick={() => signingIn = false}>Back to library</button>{/if}
      {#if $application.failure && $application.reachable !== false}<p
          class="problem"
          role="alert"
        >
          {$application.failure}
        </p>{/if}
    </main>{/if}
</div>
{/if}
{#snippet navigation()}
  <nav aria-label="Library navigation">
    <div class="server-identity">
      <p class="eyebrow">Emulation Server</p>
      <strong>{context.label}</strong>
      <span class="dim">{$application.owner ? 'Owner' : 'Library access'}</span>
    </div>
    <button type="button" aria-current={!scope && !settings ? 'page' : undefined} onclick={() => choose(null)}>Home</button>
    <p class="nav-label">Libraries</p>
    {#if $application.owner}<button type="button" onclick={() => { editing = null; drawer = false; }}>Add library</button>{/if}
    {#each $application.libraries as library (library.id)}<button
        type="button"
        aria-current={scope && 'libraryId' in scope && scope.libraryId === library.id && !settings
          ? 'page'
          : undefined}
        onclick={() => choose({ libraryId: library.id })}
      >
        {library.name}
      </button>{/each}
    {#if $application.owner}<button
        type="button"
        aria-current={scope && 'unassigned' in scope && !settings ? 'page' : undefined}
        onclick={() => choose({ unassigned: true })}
      >
        Unassigned folders
      </button>{/if}
    <button type="button" onclick={() => { guide = $application.owner ? 'host' : 'join'; drawer = false; }}>Setup guide</button>
    <div class="nav-account">
      <button
        type="button"
        aria-current={settings ? 'page' : undefined}
        onclick={() => {
          openSettings();
        }}
      >
        Settings
      </button>
      {#if $application.hasSession}<button
          type="button"
          onclick={() => {
            void application.signOut();
          }}
        >
          Sign out
        </button>{:else}<p class="dim">This network allows access without a password.</p><button type="button" onclick={() => { signingIn = true; drawer = false; }}>Sign in</button>{/if}
    </div>
  </nav>
{/snippet}
