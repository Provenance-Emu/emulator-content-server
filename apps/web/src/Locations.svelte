<script lang="ts">
  import type { ContentClient } from '@ecs/client';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import FolderPicker from './FolderPicker.svelte';
  import Modal from './components/Modal.svelte';
  import { chooseFolder, type FolderContext } from './lib/folder-selection';
  import { explain } from './lib/problems';
  import { createStorageLocations } from './lib/locations';

  let {
    client,
    onchange = () => {},
    context,
  }: {
    client: ContentClient;
    onchange?: () => void;
    context: FolderContext;
  } = $props();
  const locations = untrack(() => createStorageLocations(client, () => onchange(), context));
  let picking = $state(false);
  let pickerBusy = $state(false);
  let choosing = $state(false);
  let makeWriteTarget = $state(false);
  let failure = $state<string | null>(null);
  let disposed = false;
  let addButton = $state<HTMLButtonElement>();
  async function closePicker() {
    picking = false;
    await tick();
    if (!disposed) addButton?.focus();
  }

  onMount(() => {
    void locations.load();
  });

  async function choose() {
    failure = null;
    if (!context.folderSelection) { picking = true; makeWriteTarget = false; return; }
    if (choosing) return;
    choosing = true;
    try { const selected = await chooseFolder(context, 'upload-storage'); if (selected && !disposed) await locations.addDestination(selected, false); }
    catch (error) { if (!disposed) failure = explain(error); }
    finally { if (!disposed) choosing = false; }
  }
  onDestroy(() => { disposed = true; locations.dispose(); });
</script>

<section aria-labelledby="storage-heading">
  <div class="row">
    <h2 id="storage-heading">Upload storage</h2>
    <button type="button" disabled={$locations.busy} onclick={() => void locations.load()}>
      Refresh locations
    </button>
  </div>
  <p class="dim">
    Where new uploads are saved. Changing this does not move existing files.
  </p>
  {#if $locations.listing}
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Location</th>
            <th>Status</th>
            <th>New uploads</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              Primary <span class="dim">(server data directory)</span>
            </td>
            <td>Online</td>
            <td>
              {#if $locations.listing.writeLocationId === null}
                <span>Current target</span>
              {:else}
                <button
                  type="button"
                  disabled={$locations.busy}
                  onclick={() => void locations.select(null)}
                >
                  Use Primary
                </button>
              {/if}
            </td>
            <td></td>
          </tr>
          {#each $locations.listing.items as location (location.id)}
            <tr>
              <td>
                <strong>{location.label}</strong>
                <br />
                <span class="path dim">{location.path}</span>
              </td>
              <td>{location.online ? 'Online' : 'Offline'}</td>
              <td>
                {#if $locations.listing.writeLocationId === location.id}
                  <span>Current target</span>
                  {#if !location.online}<p class="problem">
                      New uploads are unavailable until this location returns.
                    </p>{/if}
                {:else}
                  <button
                    type="button"
                    disabled={$locations.busy || !location.online}
                    aria-label={`Store new uploads in ${location.label}`}
                    onclick={() => void locations.select(location.id)}
                  >
                    Use location
                  </button>
                {/if}
              </td>
              <td>
                <button
                  type="button"
                  disabled={$locations.busy || $locations.listing.writeLocationId === location.id}
                  aria-label={`Remove storage location ${location.label}`}
                  onclick={() => void locations.remove(location.id)}
                >
                  Remove
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if $locations.listing.items.length === 0}
      <p class="dim">No additional locations are registered. New uploads use Primary.</p>
    {/if}
    <p class="dim">
      Removing a location only forgets its registration. Locations holding stored files cannot be
      removed.
    </p>
    <button bind:this={addButton} type="button" disabled={$locations.busy || choosing || $locations.denied || !!$locations.pendingDestination} onclick={() => void choose()}>Add destination</button>
  {:else if $locations.busy}
    <p class="dim" role="status">Reading storage locations…</p>
  {/if}
  {#if $locations.failure || failure}
    <p class="problem" role="alert">{$locations.failure || failure}</p>
  {/if}
  {#if $locations.pendingDestination && !picking}<p>Destination {$locations.pendingDestination.label} was saved. The destination for new uploads has not changed.</p>
    <button type="button" disabled={$locations.busy} onclick={() => void locations.select($locations.pendingDestination?.id ?? null)}>Retry destination selection</button>
  {/if}
  {#if picking}<Modal title="Add upload destination" busy={pickerBusy || $locations.busy} onclose={() => void closePicker()}>
    <label><input type="checkbox" bind:checked={makeWriteTarget} disabled={$locations.busy || !!$locations.pendingDestination} />Make destination for new uploads</label>
    <FolderPicker {client} contextKey={context.key} origin={context.origin} title="Add upload destination" submitLabel="Add destination"
      onbusy={(busy) => (pickerBusy = busy)} oncancel={() => void closePicker()}
      onsubmit={async (selection) => { const saved = await locations.addDestination(selection, makeWriteTarget); if (!saved) throw new Error(get(locations).failure ?? 'Destination could not be added.'); return saved; }} />
  </Modal>{/if}
</section>

<style>
  .table-scroll {
    overflow-x: auto;
  }
  .path {
    overflow-wrap: anywhere;
  }
</style>
