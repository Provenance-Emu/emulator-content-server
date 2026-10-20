<script lang="ts">
  import type { LibraryScope } from '@ecs/client';
  import { get } from 'svelte/store';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { createApplication, type ServerContext } from './lib/application';
  import type { FolderSelectionAdapter } from './lib/folder-selection';
  import Login from './Login.svelte';
  import LibraryBrowser from './LibraryBrowser.svelte';
  import SettingsShell from './SettingsShell.svelte';
  import Modal from './components/Modal.svelte';
  let {
    context,
    folderSelection,
  }: { context: ServerContext; folderSelection?: FolderSelectionAdapter } = $props();
  const application = untrack(() => createApplication(context));
  let scope = $state<LibraryScope | null>(null);
  let rootId = $state('');
  let rootIntent = $state(0);
  let settings = $state(false);
  let drawer = $state(false);
  const unsubscribe = application.subscribe((state) => {
    if (!state.signedIn) {
      scope = null;
      rootId = '';
      settings = false;
      drawer = false;
    } else {
      const selected = scope;
      if (
        selected &&
        ('libraryId' in selected
          ? !state.libraries.some((library) => library.id === selected.libraryId)
          : !state.owner)
      ) {
        scope = null;
        rootId = '';
      }
    }
  });
  function choose(next: LibraryScope) {
    rootIntent++;
    scope = next;
    rootId = '';
    settings = false;
    drawer = false;
  }
  function viewFolder(root: string, library: string | null) {
    rootIntent++;
    scope = library ? { libraryId: library } : { unassigned: true };
    rootId = root;
    settings = false;
  }
  function rejectOwnerSummary(status: 401 | 403, expectedEpoch: number) {
    if (get(application).authEpoch !== expectedEpoch) return;
    if (status === 401) void application.signOut();
    else void application.revalidate();
  }
  onMount(() => {
    void application.start();
  });
  onDestroy(() => {
    unsubscribe();
    application.dispose();
  });
</script>

<div class="application-shell">
  <header class="mobile-header">
    {#if $application.signedIn}
      <button type="button" aria-label="Open navigation" onclick={() => (drawer = true)}>
        Menu
      </button>
    {/if}
    <span>{context.label}</span>
  </header>
  {#if $application.signedIn}
    <aside class="library-sidebar">{@render navigation()}</aside>
    {#if drawer}<Modal title="Library navigation" navigation onclose={() => (drawer = false)}>
        {@render navigation()}
      </Modal>{/if}
    <main id="main-content" class="application-content">
      {#if $application.failure}<p class="problem connection-message" role="status">
          {$application.failure}
        </p>{/if}
      {#key `${context.key}:${$application.authEpoch}`}
        {@const expectedEpoch = $application.authEpoch}
        <div hidden={settings}>
          <LibraryBrowser
            {context}
            {application}
            {scope}
            {rootId}
            {rootIntent}
            owner={$application.owner}
            libraries={$application.libraries}
            onsettings={() => (settings = true)}
          />
        </div>
        {#if settings}<SettingsShell
            client={context.client}
            appState={$application}
            onback={() => (settings = false)}
            onview={viewFolder}
            onrejected={(status) => rejectOwnerSummary(status, expectedEpoch)}
          />{/if}
      {/key}
    </main>
  {:else}<main class="login-content">
      <p class="eyebrow">{context.label}</p>
      <h1>Emulator Content Server</h1>
      {#if $application.settled}{#key $application.authEpoch}{@const expectedEpoch =
            $application.authEpoch}<Login
            client={context.client}
            setup={$application.capabilities?.bootstrapped === false}
            onsignin={(session) => {
              void application.adoptSession(session, expectedEpoch);
            }}
          />{/key}{:else}<p role="status">Connecting to server…</p>{/if}{#if $application.failure}<p
          class="problem"
          role="alert"
        >
          {$application.failure}
        </p>{/if}
    </main>{/if}
</div>
{#snippet navigation()}
  <nav aria-label="Library navigation">
    <div class="server-identity">
      <p class="eyebrow">Content server</p>
      <strong>{context.label}</strong>
      <span class="dim">{$application.owner ? 'Owner' : 'Library access'}</span>
    </div>
    <p class="nav-label">Libraries</p>
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
    <div class="nav-account">
      <button
        type="button"
        aria-current={settings ? 'page' : undefined}
        onclick={() => {
          settings = true;
          drawer = false;
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
        </button>{:else}<p class="dim">This network allows access without a password.</p>{/if}
    </div>
  </nav>
{/snippet}
