<script lang="ts">
  import type { Library } from '@ecs/client';
  import { tick, untrack } from 'svelte';
  import type { ApplicationState, ServerContext } from './lib/application';
  import type { FolderContext } from './lib/folder-selection';
  import type { StoredSession } from './lib/session';
  import { createSetupProgress, type SetupMode, type SetupStep } from './lib/setup-progress';
  import type { SettingsSection } from './lib/shell-navigation';
  import Login from './Login.svelte';
  import LibraryEditor from './LibraryEditor.svelte';
  import SetupGames from './SetupGames.svelte';
  import SetupEmulators from './SetupEmulators.svelte';
  import SetupPlugins from './SetupPlugins.svelte';
  let {
    context,
    appState,
    folderContext,
    mode = 'host',
    setupCode,
    revealSetupCode,
    onsignin,
    onchange,
    onrejected,
    onclose,
    onsettings,
    onchoosecomputer,
  }: {
    context: ServerContext;
    appState: ApplicationState;
    folderContext: FolderContext;
    mode?: SetupMode;
    setupCode?: string;
    revealSetupCode?: () => Promise<void>;
    onsignin: (session: StoredSession, expectedEpoch: number) => void;
    onchange: () => Promise<void>;
    onrejected: (status: 401 | 403) => void;
    onclose: (libraryId: string, completed: boolean) => void;
    onsettings: (section: SettingsSection) => void;
    onchoosecomputer?: () => void;
  } = $props();
  const progress = untrack(() => createSetupProgress(context.origin, mode));
  let busy = $state(false);
  let editing = $state<Library | null | undefined>(undefined);
  const ownerAccess = $derived(appState.owner && appState.hasSession);
  const library = $derived(appState.libraries.find((item) => item.id === $progress.libraryId));
  const steps = $derived(
    $progress.mode === 'join'
      ? (['account', 'library', 'ready'] as SetupStep[])
      : (['account', 'library', 'games', 'emulators', 'plugins', 'ready'] as SetupStep[]),
  );
  const step = $derived.by((): SetupStep => {
    if (!$progress.done && (!appState.signedIn || ($progress.mode === 'host' && !ownerAccess)))
      return 'account';
    if (!['account', 'library'].includes($progress.step) && !library && appState.settled)
      return 'library';
    return steps.includes($progress.step) ? $progress.step : 'account';
  });
  const labels: Record<SetupStep, string> = {
    account: 'Your account',
    library: 'Your library',
    games: 'Add games',
    emulators: 'Play your games',
    plugins: 'Optional helpers',
    ready: 'Ready',
  };
  const locked = $derived(busy || editing !== undefined);
  async function go(next: SetupStep) {
    if (locked) return;
    progress.update({ step: next, done: false, paused: false });
    await tick();
    document.getElementById('setup-guide-heading')?.focus({ preventScroll: true });
  }
  function next() {
    const index = steps.indexOf(step);
    const next = steps[index + 1];
    if (next) void go(next);
  }
  function close(completed: boolean) {
    if (locked) return;
    progress.update({ done: completed, paused: !completed });
    onclose(library?.id ?? '', completed);
  }
  function rejected(status: 401 | 403) {
    progress.update({ step: 'account' });
    onrejected(status);
  }
  function manage(section: SettingsSection) {
    if (locked) return;
    progress.update({ paused: true });
    onsettings(section);
  }
  $effect(() => {
    const only = appState.libraries.length === 1 ? appState.libraries[0] : undefined;
    if (step === 'library' && !library && only) progress.update({ libraryId: only.id });
  });
  const canContinue = $derived(
    step === 'account'
      ? $progress.mode === 'join'
        ? appState.signedIn
        : ownerAccess
      : step === 'library'
        ? !!library
        : true,
  );
</script>

<main id="main-content" class="setup-guide" tabindex="-1">
  <header class="setup-guide-header">
    <p class="eyebrow">Emulation Server · Setup</p>
    <p class="dim">{context.label}</p>
    <nav aria-label="Setup progress">
      <ol>
        {#each steps as entry, index}<li aria-current={entry === step ? 'step' : undefined}>
            <span>{index + 1}</span><span>{labels[entry]}</span>
          </li>{/each}
      </ol>
    </nav>
    <p class="setup-step-count">Step {steps.indexOf(step) + 1} of {steps.length}</p>
    <h1 id="setup-guide-heading" tabindex="-1">{labels[step]}</h1>
  </header>
  <div class="setup-guide-body">
    {#if step === 'account'}
      {#if appState.capabilities?.bootstrapped === false}
        <p>Create the account you’ll use to add games and manage this library.</p>
        {#key appState.authEpoch}{@const expectedEpoch = appState.authEpoch}<Login
            client={context.client}
            origin={context.origin}
            setup
            simple
            onbusy={(value) => (busy = value)}
            {setupCode}
            {revealSetupCode}
            onsignin={(session) => onsignin(session, expectedEpoch)}
          />{/key}
      {:else if $progress.mode === 'join' && appState.signedIn}
        <p>You’re connected. Choose a library next and start browsing your games.</p>
        <button
          type="button"
          class="text-button"
          onclick={() => progress.update({ mode: 'host', step: 'account' })}
          >I want to set up or manage this library</button
        >
      {:else if ownerAccess}
        <p>You’re signed in and can set up this library.</p>
      {:else}
        <p>
          Sign in with the account you created for this library. The owner account can add games and
          install emulators and helpers.
        </p>
        {#key appState.authEpoch}{@const expectedEpoch = appState.authEpoch}<Login
            client={context.client}
            origin={context.origin}
            simple
            onbusy={(value) => (busy = value)}
            onsignin={(session) => onsignin(session, expectedEpoch)}
          />{/key}
        {#if appState.signedIn}<button
            type="button"
            class="text-button"
            onclick={() => {
              progress.update({ mode: 'join' });
            }}>Just browse for now</button
          >{/if}
      {/if}
      {#if onchoosecomputer}<button
          type="button"
          class="text-button"
          disabled={locked}
          onclick={() => {
            progress.update({ paused: true });
            onchoosecomputer?.();
          }}>Choose another computer</button
        >{/if}
    {:else if step === 'library'}
      <p>
        A library is a collection of games. Choose an existing collection or create one for your
        games.
      </p>
      <div class="setup-library-choices">
        {#each appState.libraries as item (item.id)}<button
            type="button"
            class:selected={$progress.libraryId === item.id}
            aria-pressed={$progress.libraryId === item.id}
            onclick={() => progress.update({ libraryId: item.id })}
            ><strong>{item.name}</strong><span
              >{$progress.libraryId === item.id ? 'Selected' : 'Use this library'}</span
            ></button
          >{/each}
      </div>
      {#if ownerAccess && $progress.mode === 'host'}<div class="actions">
          {#if library}<button type="button" onclick={() => (editing = library)}
              >Rename this library</button
            >{/if}
          <button type="button" onclick={() => (editing = null)}>Create a new library</button>
        </div>{/if}
      {#if !appState.libraries.length && !ownerAccess}<p>
          There are no libraries shared with this account yet. Ask the person managing the server to
          share one with you.
        </p>{/if}
    {:else if step === 'games' && library}
      {#key appState.authEpoch}<SetupGames
          client={context.client}
          context={folderContext}
          serverContext={context}
          libraryId={library.id}
          onbusy={(value) => (busy = value)}
        />{/key}
    {:else if step === 'emulators' && library}
      {#key appState.authEpoch}<SetupEmulators
          client={context.client}
          libraryId={library.id}
          onrejected={rejected}
          {onchange}
          onbusy={(value) => (busy = value)}
          onmanage={() => manage('emulators')}
        />{/key}
    {:else if step === 'plugins'}
      {#key appState.authEpoch}<SetupPlugins
          client={context.client}
          onrejected={rejected}
          onbusy={(value) => (busy = value)}
          onmanage={() => manage('plugins')}
        />{/key}
    {:else if step === 'ready'}
      <h2>{library?.name ?? 'Your library'} is ready to open</h2>
      <p>Open a game to play it or download it to another emulator.</p>
      {#if $progress.mode === 'host'}<p>
          You can add folders, change emulators and manage helpers in Settings. Reopen Setup guide
          whenever you need it.
        </p>{/if}
      <button type="button" class="text-button" onclick={() => void go('account')}
        >Review setup</button
      >
      <details class="setup-alternative">
        <summary>Connection details</summary>
        <p>{context.origin}</p>
      </details>
    {/if}
  </div>
  <footer class="setup-guide-footer">
    <div class="actions">
      {#if steps.indexOf(step) > 0}<button
          type="button"
          disabled={locked}
          onclick={() => void go(steps[steps.indexOf(step) - 1] ?? 'account')}>Back</button
        >{/if}
      {#if step === 'ready'}<button
          type="button"
          class="primary"
          disabled={locked}
          onclick={() => close(true)}>Open your library</button
        >
      {:else}<button type="button" class="primary" disabled={locked || !canContinue} onclick={next}
          >Continue</button
        >{/if}
    </div>
    <button type="button" class="text-button" disabled={locked} onclick={() => close(false)}
      >Finish later</button
    >
  </footer>
  {#if editing !== undefined}<LibraryEditor
      client={context.client}
      context={folderContext}
      library={editing ?? undefined}
      onclose={() => (editing = undefined)}
      oncomplete={(id) => {
        progress.update({ libraryId: id });
        editing = undefined;
      }}
    />{/if}
</main>

<style>
  .setup-guide {
    width: min(100% - 2rem, 48rem);
    margin: clamp(1rem, 5vh, 4rem) auto;
    padding: clamp(1.25rem, 4vw, 2.5rem);
    border: 1px solid var(--line);
    border-radius: 0.75rem;
    background: var(--panel, transparent);
  }
  .setup-guide-header h1 {
    margin-block: 0.5rem 1.25rem;
  }
  nav ol {
    display: flex;
    padding: 0;
    margin-block: 1.5rem;
    gap: 0.5rem;
    list-style: none;
  }
  nav li {
    flex: 1;
    display: grid;
    gap: 0.35rem;
    font-size: 0.75rem;
    color: var(--dim);
  }
  nav li > span:first-child {
    display: grid;
    place-content: center;
    width: 1.6rem;
    height: 1.6rem;
    border: 1px solid var(--line);
    border-radius: 50%;
  }
  nav li[aria-current] {
    color: inherit;
    font-weight: 650;
  }
  nav li[aria-current] > span:first-child {
    border-color: currentColor;
  }
  .setup-step-count {
    font-size: 0.8rem;
    color: var(--dim);
  }
  .setup-guide-body {
    min-height: 12rem;
  }
  .setup-guide-footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    padding-top: 1.5rem;
    margin-top: 1.5rem;
    border-top: 1px solid var(--line);
  }
  .setup-library-choices {
    display: grid;
    gap: 0.75rem;
    margin-block: 1rem;
  }
  .setup-library-choices button {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 1rem;
    text-align: left;
  }
  .setup-library-choices button.selected {
    border-color: currentColor;
  }
  :global(.setup-guide .setup-alternative) {
    margin-top: 1.5rem;
  }
  :global(.setup-guide .setup-alternative > summary) {
    cursor: pointer;
    padding-block: 0.5rem;
  }
  :global(.setup-guide .sign-in-panel) {
    max-width: none;
    padding: 0;
    border: 0;
  }
  @media (max-width: 600px) {
    nav li > span:last-child {
      display: none;
    }
    .setup-guide {
      margin-block: 1rem;
    }
    .setup-guide-footer .actions {
      flex: 1;
    }
  }
</style>
