<script lang="ts">
  import type { WebPlayerAsset } from '@ecs/client';
  import { onDestroy, tick } from 'svelte';
  import FormField from './FormField.svelte';
  import { bytes } from '../lib/format';

  let { assets, canInstall = false, disabled = false, oninstall }: {
    assets: WebPlayerAsset[];
    canInstall?: boolean;
    disabled?: boolean;
    oninstall: (file: File) => Promise<boolean>;
  } = $props();
  let selected = $state<File | null>(null);
  let input = $state<HTMLInputElement>();
  let submitButton = $state<HTMLButtonElement>();
  let disposed = false;
  const replaces = $derived(selected && assets.some(asset => asset.name.toLowerCase() === selected?.name.toLowerCase()));
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const file = selected;
    if (!file || disabled || !canInstall) return;
    const saved = await oninstall(file);
    if (disposed) return;
    if (saved) { selected = null; if (input) input.value = ''; }
    await tick();
    if (disposed || disabled) return;
    if (saved) input?.focus();
    else submitButton?.focus();
  }
  onDestroy(() => { disposed = true; selected = null; });
</script>

{#if assets.length || canInstall}
  <div class="emulator-system-files">
    <h4>System and support files</h4>
    {#if assets.length}<ul aria-label="Installed system and support files">
        {#each assets as asset (asset.name)}<li><span class="path">{asset.name}</span><span class="dim">{bytes(asset.sizeBytes)}</span></li>{/each}
      </ul>{/if}
    {#if canInstall}
      <form class="settings-form" onsubmit={event => void submit(event)}>
        <FormField label="Add system file" help="Use the filename required by the emulator. Up to 32 MiB; shared with players on this server.">
          {#snippet children(attributes)}<input {...attributes} bind:this={input} type="file" disabled={disabled}
              onchange={event => { selected = event.currentTarget.files?.[0] ?? null; }} />{/snippet}
        </FormField>
        {#if replaces}<p class="dim" role="status">Installing this file replaces the existing {selected?.name}.</p>{/if}
        <button bind:this={submitButton} type="submit" disabled={disabled || !selected}>Install system file</button>
      </form>
    {/if}
  </div>
{/if}

<style>
  .emulator-system-files { margin-top: var(--space-3); padding-top: var(--space-3); border-top: var(--border-width) solid var(--line); }
  h4 { margin: 0 0 var(--space-2); font-size: var(--text-label); font-weight: var(--weight-semibold); }
  p { margin: var(--space-2) 0; max-width: var(--content-measure); }
  ul { list-style: none; margin: 0 0 var(--space-3); padding: 0; display: grid; gap: var(--space-1); }
  li { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
  .path { overflow-wrap: anywhere; }
  form { margin-bottom: 0; }
</style>
