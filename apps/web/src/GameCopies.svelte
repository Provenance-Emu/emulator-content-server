<script lang="ts">
  import type { ContentClient, GameRomCopy, Item, SourceFile } from '@ecs/client';
  import { contentExtensions } from './player/runtime';
  import type { BrowserCore } from './player/runtime';
  import type { PlayableCores } from './player/links';
  import { explain } from './lib/problems';

  let { client, item = null, source = null, cores = null, owner, onchanged, onplay }: {
    client: ContentClient;
    item?: Item | null;
    source?: SourceFile | null;
    cores?: PlayableCores;
    owner: boolean;
    onchanged: () => void;
    onplay: (href: string) => void;
  } = $props();

  let opened = $state(false);
  let working = $state(false);
  let error = $state('');
  let copies = $state<GameRomCopy[]>([]);
  let matches = $state<Item[]>([]);
  let query = $state('');
  let target = $state('');
  let title = $state('');
  const installed = $derived(cores ? (Array.isArray(cores) ? cores : [cores as BrowserCore]) : []);
  const compatible = $derived(installed.filter(core => item && core.systems.includes(item.systemIdentifier)));

  async function act(action: () => Promise<void>) {
    working = true;
    error = '';
    try { await action(); }
    catch (failure) { error = explain(failure); }
    finally { working = false; }
  }

  async function search() {
    if (!source?.libraryId || !source.systemId) return;
    const page = await client.browse({ libraryId: source.libraryId, category: 'games',
      systemId: source.systemId, search: query, limit: 50 });
    matches = page.items.flatMap(entry => entry.item ? [entry.item] : []);
    target = '';
  }

  function open() {
    opened = true;
    if (source) {
      title = source.title ?? source.name.replace(/\.[^.]+$/, '');
      void act(search);
    } else if (item) {
      const id = item.id;
      void act(async () => { copies = (await client.gameRomCopies(id)).items; });
    }
  }

  async function play() {
    if (!item) return;
    for (const core of compatible) {
      const formats = contentExtensions(core).filter(format => !['m3u', 'ccd'].includes(format));
      const { copy } = await client.selectGameRom(item.id, {
        systems: [{ systemId: item.systemIdentifier, formats }],
        maxBytes: core.maxContentBytes,
        allowDiscBundles: true,
      });
      if (!copy) continue;
      const itemParam = `item=${encodeURIComponent(item.id)}`;
      const file = `${copy.kind === 'asset' ? 'asset' : 'source'}=${encodeURIComponent(copy.id)}`;
      const profile = 'profileVersion' in core ? `&profile=${encodeURIComponent(core.id)}` : '';
      onplay(`/play/?${itemParam}&${file}${profile}`);
      return;
    }
    throw new Error('No available copy matches your installed emulators.');
  }
</script>

{#if item || (owner && source?.libraryId && source.systemId && source.kind === 'rom')}
<section aria-label="Game copies">
  {#if !opened}<button type="button" onclick={open}>{source ? 'Link to a game' : 'View game copies'}</button>
  {:else if source}
    <h2>Link to a game</h2>
    <form onsubmit={(event) => { event.preventDefault(); void act(search); }}>
      <label>Find an existing game <input type="search" bind:value={query} /></label>
      <button type="submit" disabled={working}>Search</button>
    </form>
    <label>Game <select bind:value={target}><option value="">Create a new game</option>
      {#each matches as match (match.id)}<option value={match.id}>{match.title}</option>{/each}
    </select></label>
    {#if !target}<label>Game title <input bind:value={title} maxlength="256" /></label>{/if}
    <button type="button" disabled={working || (!target && !title.trim())} onclick={() => void act(async () => {
      if (!source) return;
      await client.linkGameSource(source.id, target ? {itemId: target} : {title});
      onchanged();
    })}>Link copy</button>
  {:else if item}
    <h2>Game copies</h2>
    {#if compatible.length}<button type="button" disabled={working} onclick={() => void act(play)}>Play best copy</button>{/if}
    {#if copies.length}
      <ul>{#each copies as copy (copy.id)}
        <li>{copy.name} · {copy.format.toUpperCase()} · {copy.availability === 'local' ? (copy.medium === 'network' || copy.medium === 'icloud' ? 'Remote' : 'Available') : 'Unavailable'}
          {#if owner && copy.kind === 'source'}
            <button type="button" disabled={working} onclick={() => void act(async () => {
              await client.linkGameSource(copy.id, { itemId: null });
              copies = copies.filter(candidate => candidate.id !== copy.id);
              onchanged();
            })}>Unlink copy</button>
          {/if}
        </li>
      {/each}</ul>
    {:else if !working}<p>No alternate copies.</p>{/if}
  {/if}
  {#if error}<p class="problem" role="alert">{error}</p>{/if}
</section>
{/if}
