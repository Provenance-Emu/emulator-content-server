<script lang="ts" module>
  // RetroArch "Monochrome" icons, CC BY 4.0. See assets/systems/NOTICE.txt.
  const files = import.meta.glob<string>('../assets/systems/*.png', {
    eager: true,
    query: '?url',
    import: 'default',
  });
  const icons = new Map(
    Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -4), url]),
  );
  /** The picture for a system, when there is one. */
  export function systemIcon(id: string | null | undefined): string | undefined {
    const name = id?.startsWith('com.provenance.') ? id.slice('com.provenance.'.length) : id;
    return name ? icons.get(name) : undefined;
  }
</script>

<script lang="ts">
  let { system }: { system: string | null | undefined } = $props();
  const url = $derived(systemIcon(system));
</script>

<!-- Drawn as a mask so the picture takes the colour of the text beside it in either theme. -->
{#if url}<span
    class="system-icon"
    aria-hidden="true"
    style:mask-image={`url("${url}")`}
    style:-webkit-mask-image={`url("${url}")`}
  ></span>{/if}
