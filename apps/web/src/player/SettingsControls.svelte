<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { explain } from '../lib/problems';
  import { CoreOptionRejected, type CommandChannel } from './commands.js';
  import type { CoreOption } from './options.js';
  import type { PlayerPreferences, PreferenceStore } from './preferences.js';
  import type { PlayerRuntime } from './runtime.js';
  import { validShaderId, type ShaderId, type ShaderResult } from './shaders.js';

  let {
    runtime, commands, store, initial, disabled = false, active = true, view = 'all',
    onbusy = () => {}, onready = () => {},
  }: {
    runtime: PlayerRuntime;
    commands: CommandChannel | null;
    store: PreferenceStore;
    initial: PlayerPreferences;
    disabled?: boolean;
    active?: boolean;
    view?: 'all' | 'options' | 'video';
    onbusy?: (busy: boolean) => void;
    onready?: () => void;
  } = $props();

  const batchSize = 16;
  let working = $state(false);
  let initialized = $state(false);
  let failure = $state<string | null>(null);
  let notice = $state('');
  let unavailable = $state('');
  let options = $state<CoreOption[]>([]);
  let choices = $state<Record<string, CoreOption>>({});
  let rowErrors = $state<Record<string, string>>({});
  let rowMessages = $state<Record<string, string>>({});
  let search = $state('');
  let limit = $state(batchSize);
  let updatingKey = $state<string | null>(null);
  let commandFailed = $state(false);
  let choiceRetry = $state(0);
  let shaders = $state(false);
  let shader = $state<ShaderId | 'unknown'>('off');
  let shaderStatus = $state('Shaders off.');
  let shaderRememberable = $state(true);
  let overrides = $state<Record<string, string>>({});
  let scopes = $state('Session only');
  let rememberScope = $state<'core' | 'game'>(untrack(() => store.hasGame ? 'game' : 'core'));
  let shaderEdit: ShaderId | undefined;
  let shaderGeneration = 0;
  let failureHandled = false;
  let hydrationGeneration = 0;
  let mounted = true;
  const blocked = $derived(working || disabled);
  const matches = $derived(options.filter(option =>
    `${option.description} ${option.key}`.toLowerCase().includes(search.trim().toLowerCase()),
  ));

  function updateScopes() {
    const loaded = store.load();
    scopes = loaded.scopes.length ? `Remembered for this ${loaded.scopes.join(' and ')}.` : 'Session only.';
    if (loaded.warning) notice = loaded.warning;
  }

  async function act(operation: () => Promise<void>, focus = true) {
    if (working || disabled) return;
    const returnFocus = document.activeElement;
    working = true;
    onbusy(true);
    failure = null;
    try {
      if (focus) await runtime.focus?.();
      await operation();
    } catch (error) {
      if (mounted) failure = explain(error);
    } finally {
      if (mounted) {
        working = false;
        onbusy(false);
        await tick();
        if (focus && returnFocus instanceof HTMLElement && returnFocus.isConnected && !returnFocus.closest('[hidden]') && (document.activeElement === returnFocus || document.activeElement === document.body || document.activeElement?.matches('canvas,iframe'))) {
          returnFocus.focus({ preventScroll: true });
        }
      }
    }
  }

  function failedShader(result: ShaderResult, id: ShaderId | 'unknown') {
    failureHandled = true;
    shader = result.selection ?? 'unknown';
    shaderRememberable = shader === 'off';
    shaderEdit = shader === 'off' ? 'off' : undefined;
    shaderStatus = shader === 'off'
      ? 'Preset failed. Shaders restored to Off.'
      : 'Shader state unknown. Reload the player before trying again.';
    failure = shaderStatus;
    if (validShaderId(id) && id !== 'off') {
      try {
        store.forgetShader(id);
        updateScopes();
        notice = 'The failed shader was removed from remembered settings.';
      } catch {
        notice = 'The failed shader could not be removed from local preferences. Clear preferences before the next launch.';
      }
    }
  }

  async function applyShader(id: ShaderId, rememberEdit = true) {
    shaderGeneration++;
    failureHandled = false;
    shaderRememberable = false;
    shader = 'unknown';
    shaderStatus = 'Applying shader…';
    try {
      if (!runtime.setShader) throw Error('Shaders unavailable');
      const result = await runtime.setShader(id);
      shader = result.selection ?? 'unknown';
      if (result.status === 'failed') {
        failedShader(result, id);
        throw Error(shaderStatus);
      }
      shaderRememberable = true;
      if (rememberEdit) shaderEdit = id;
      shaderStatus = id === 'off' ? 'Shaders off.'
        : `${id === 'scanlines' ? 'Scanlines' : 'LCD grid'} requested. The runtime accepted the preset and drew new frames. Final compilation status is not exposed.`;
    } catch (error) {
      if (shader === 'unknown') shaderStatus = 'Shader state unknown. Reload the player before trying again.';
      throw error;
    }
  }

  function chooseShader(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    const id = select.value;
    select.value = shader;
    if (validShaderId(id)) void act(() => applyShader(id));
  }

  // Choice reads share the runtime command channel, but never put gameplay into a busy state.
  async function hydrate(rows: CoreOption[], generation: number) {
    for (const option of rows) {
      if (!mounted || generation !== hydrationGeneration || working || disabled || commandFailed) return;
      if (!commands || choices[option.key] || rowErrors[option.key]) continue;
      try {
        const detailed = await commands.option(option.key);
        if (!mounted || generation !== hydrationGeneration) return;
        choices = { ...choices, [option.key]: detailed };
        if (option.value !== detailed.value) {
          options = options.map(row => row.key === option.key ? { ...row, value: detailed.value } : row);
        }
      } catch (error) {
        if (!mounted || generation !== hydrationGeneration) return;
        rowErrors = { ...rowErrors, [option.key]: explain(error) };
        if (!(error instanceof CoreOptionRejected)) {
          commandFailed = true;
          failure = explain(error);
          return;
        }
      }
    }
  }

  $effect(() => {
    choiceRetry;
    const rows = matches.slice(0, limit);
    const paused = !initialized || blocked || commandFailed || !active || view === 'video';
    const generation = ++hydrationGeneration;
    if (!paused) untrack(() => void hydrate(rows, generation));
    return () => { hydrationGeneration++; };
  });

  function changeOption(option: CoreOption, event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    const value = select.value;
    select.value = option.value;
    select.focus({ preventScroll: true });
    if (blocked || commandFailed || !commands) return;
    void act(async () => {
      updatingKey = option.key;
      rowErrors = { ...rowErrors, [option.key]: '' };
      rowMessages = { ...rowMessages, [option.key]: '' };
      try {
        const applied = await commands!.setOption(option.key, value);
        if (!mounted) return;
        overrides = { ...overrides, [option.key]: applied.value };
        options = options.map(row => row.key === option.key ? applied : row);
        choices = { [option.key]: applied };
        options = await commands!.listOptions();
        if (!mounted) return;
        rowMessages = { ...rowMessages, [option.key]: 'Applied to this session. Some options need a fresh launch.' };
      } catch (error) {
        if (!mounted) return;
        rowErrors = { ...rowErrors, [option.key]: explain(error) };
        if (!(error instanceof CoreOptionRejected)) commandFailed = true;
      } finally {
        updatingKey = null;
      }
    });
  }

  function remember() {
    void act(async () => {
      if (!shaderRememberable || shader === 'unknown') throw Error('Resolve the shader failure in Video before remembering settings');
      const info = await runtime.settingsInfo?.();
      if (info?.shaderResult?.status === 'failed' && !failureHandled) {
        failedShader(info.shaderResult, shader);
        throw Error(shaderStatus);
      }
      store.rememberChanges(rememberScope, {
        options: { ...overrides },
        ...(shaderEdit !== undefined ? { shader: shaderEdit } : {}),
      });
      updateScopes();
      notice = `Remembered for this ${rememberScope === 'game' ? 'game' : 'core'} in this browser.`;
    }, false);
  }

  function clear(scope: 'core' | 'game') {
    void act(async () => {
      store.clear(scope);
      updateScopes();
      notice = 'Remembered settings cleared. Running settings remain until changed or a fresh launch.';
    }, false);
  }

  onMount(() => {
    void act(async () => {
      updateScopes();
      const info = await runtime.settingsInfo?.();
      if (!mounted) return;
      shaders = info?.shaders === true;
      if (commands && info?.commands !== false) {
        try {
          options = await commands.listOptions();
          if (!options.length) unavailable = 'This core reports no options.';
        } catch (error) {
          if (error instanceof CoreOptionRejected) unavailable = error.message;
          else { commandFailed = true; throw error; }
        }
      } else unavailable = 'This build does not expose core-option commands.';
      if (!mounted) return;
      const ignored = Object.entries(initial.options).some(([key, value]) =>
        !options.some(option => option.key === key && option.value === value),
      );
      if (ignored) notice = 'Some remembered options were not accepted by this build. Review their current values.';
      if (initial.shader !== 'off') {
        if (shaders) await applyShader(initial.shader, false);
        else notice = 'The remembered shader is unavailable in this build.';
      }
    }, false).finally(() => {
      if (mounted) { initialized = true; onready(); }
    });
    let checking = false;
    const timer = setInterval(async () => {
      if (!mounted || working || disabled || !shaders || checking) return;
      checking = true;
      const generation = shaderGeneration;
      try {
        const info = await runtime.settingsInfo?.();
        if (mounted && !working && !disabled && generation === shaderGeneration && info?.shaderResult?.status === 'failed' && !failureHandled) {
          failedShader(info.shaderResult, shader);
        }
      } catch { /* The active operation or session teardown reports transport failure. */ }
      finally { checking = false; }
    }, 1000);
    return () => { mounted = false; hydrationGeneration++; clearInterval(timer); };
  });
</script>

<section class="settings-controls" aria-label={view === 'all' ? 'Core options and shaders' : view === 'video' ? 'Shaders' : 'Core options'}>
  {#if view !== 'video'}
    <h2>Core options</h2>
    <p class="dim">Change a value to apply it to this session.</p>
    {#if unavailable}<p class="dim">{unavailable}</p>{/if}
    {#if options.length}
      <label class="core-option-search">Search core options<input type="search" bind:value={search} oninput={() => limit = batchSize} /></label>
      <p class="core-option-count dim" role="status">{matches.length} option{matches.length === 1 ? '' : 's'}{#if matches.length > limit} · showing {limit}{/if}</p>
      <div class="core-option-list">
        {#each matches.slice(0, limit) as option (option.key)}
          {@const detailed = choices[option.key]}
          {@const error = rowErrors[option.key]}
          <div class="core-option-row" aria-busy={updatingKey === option.key}>
            <label for={`core-option-${option.key}`}>{option.description || option.key}</label>
            <select id={`core-option-${option.key}`} value={option.value}
              disabled={blocked || commandFailed || !detailed}
              aria-describedby={`core-option-info-${option.key}`}
              aria-invalid={!!error}
              onchange={event => changeOption(option, event)}>
              {#if detailed?.values}
                {#each detailed.values as value}<option {value}>{value}</option>{/each}
              {:else}<option value={option.value}>{option.value}</option>{/if}
            </select>
            <div class="core-option-info" id={`core-option-info-${option.key}`}>
              {#if updatingKey === option.key}<span role="status">Applying…</span>
              {:else if error}<span class="problem" role="alert">{error}</span>
                {#if !detailed && !commandFailed}<button type="button" disabled={blocked} aria-label={`Retry choices for ${option.description || option.key}`}
                  onclick={() => { rowErrors = { ...rowErrors, [option.key]: '' }; choiceRetry++; }}>Retry choices</button>{/if}
              {:else if !detailed && !commandFailed}<span class="dim">Loading choices…</span>
              {:else if rowMessages[option.key]}<span role="status">{rowMessages[option.key]}</span>{/if}
            </div>
          </div>
        {/each}
      </div>
      {#if matches.length > limit}<button type="button" onclick={() => limit += batchSize}>Show more options</button>{/if}
      {#if !matches.length}<p class="dim">No options match this search.</p>{/if}
    {/if}
  {/if}
  {#if view !== 'options'}
    <div class="shader-settings">
      <h2>Shaders</h2>
      <label>Shader preset<select value={shader} disabled={blocked || !shaders || shader === 'unknown'} onchange={chooseShader}>
        {#if shader === 'unknown'}<option value="unknown">Unknown — reload player</option>{/if}
        <option value="off">Off</option><option value="scanlines">Scanlines</option><option value="lcd">LCD grid</option>
      </select></label>
      {#if shaders}<p role="status">{shaderStatus}</p>
      {:else}<p class="dim">This build does not expose the required GLSL shader hooks.</p>{/if}
    </div>
  {/if}
  <div class="player-preference-actions">
    <div class="player-controls">
      <label>Remember changes for<select bind:value={rememberScope} disabled={blocked}>
        {#if store.hasGame}<option value="game">This game</option>{/if}<option value="core">This core</option>
      </select></label>
      <button type="button" disabled={blocked || commandFailed || !shaderRememberable || (!options.length && !shaders)} onclick={remember}>Remember changes</button>
    </div>
    <p class="dim">{scopes} Local to this browser, server, and exact emulator build.</p>
    <details class="player-technical-details"><summary>Remembered settings and technical details</summary>
      <p class="dim">Changes remain session-only until remembered. Clearing preferences uses the core’s defaults on a fresh launch.</p>
      <div class="player-controls">
        {#if store.hasGame}<button type="button" disabled={blocked} onclick={() => clear('game')}>Clear game preferences</button>{/if}
        <button type="button" disabled={blocked} onclick={() => clear('core')}>Clear core preferences</button>
      </div>
      {#if view !== 'video' && options.length}<p class="dim">The runtime reports choices without defaults or categories. Search also matches these technical keys.</p>
        <dl class="core-option-keys">{#each matches.slice(0, limit) as option (option.key)}<div><dt>{option.description || option.key}</dt><dd><code>{option.key}</code></dd></div>{/each}</dl>
      {/if}
      {#if view !== 'options'}<p class="dim">Screenshots include the shader. State previews may show raw game pixels. Sharp/smooth display filtering is separate. Off uses the least graphics work.</p>{/if}
    </details>
  </div>
  {#if working}<p role="status">Updating player settings…</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if failure}<p class="problem" role="alert">{failure}</p>{/if}
</section>
