<script lang="ts">
  import type { ContentClient } from '@ecs/client';
  import { onMount, untrack } from 'svelte';
  import FolderPicker from './FolderPicker.svelte';
  import { createStorageLocations } from './lib/locations';

  let {
    client,
    onchange = () => {},
  }: {
    client: ContentClient;
    onchange?: () => void;
  } = $props();
  const locations = untrack(() => createStorageLocations(client, () => onchange()));
  let path = $state('');
  let label = $state('');
  let picking = $state(false);

  onMount(() => {
    void locations.load();
  });

  function choose(chosen: string) {
    path = chosen;
    picking = false;
    if (!label.trim()) label = chosen.split(/[/\\]/).filter(Boolean).at(-1) ?? chosen;
  }
  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (await locations.add({ path: path.trim(), label: label.trim() })) {
      path = '';
      label = '';
      picking = false;
    }
  }
</script>

<section aria-labelledby="storage-heading">
  <div class="row">
    <h2 id="storage-heading">Upload storage</h2>
    <button type="button" disabled={$locations.busy} onclick={() => void locations.load()}>
      Refresh locations
    </button>
  </div>
  <p class="dim">
    New uploads are stored in the selected location. Existing files stay where they are. Library
    folders are indexed in place; upload storage holds new uploads.
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
    {#if picking && !$locations.busy}
      <FolderPicker {client} onchoose={choose} oncancel={() => (picking = false)} />
    {/if}
    <form onsubmit={add}>
      <label>
        Upload storage folder on the server
        <input
          bind:value={path}
          placeholder="/Volumes/Storage/Content"
          required
          disabled={$locations.busy}
        />
      </label>
      <label>
        Destination name
        <input
          bind:value={label}
          maxlength="80"
          placeholder="External drive"
          required
          disabled={$locations.busy}
        />
      </label>
      <button type="button" disabled={$locations.busy} onclick={() => (picking = !picking)}>
        {picking ? 'Hide browser' : 'Browse server folders'}
      </button>
      <button type="submit" disabled={$locations.busy}>Add destination</button>
    </form>
  {:else if $locations.busy}
    <p class="dim" role="status">Reading storage locations…</p>
  {/if}
  {#if $locations.failure}
    <p class="problem" role="alert">{$locations.failure}</p>
  {/if}
</section>

<style>
  .table-scroll {
    overflow-x: auto;
  }
  .path {
    overflow-wrap: anywhere;
  }
</style>
