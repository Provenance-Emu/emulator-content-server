<script lang="ts">
  let { metadata }: { metadata: Record<string, unknown> } = $props();

  const humanKeys = ['publisher', 'developer', 'year', 'genre', 'region', 'language', 'description'] as const;
  const humanLabels: Record<(typeof humanKeys)[number], string> = {
    publisher: 'Publisher',
    developer: 'Developer',
    year: 'Year',
    genre: 'Genre',
    region: 'Region',
    language: 'Language',
    description: 'Description',
  };
  const evidenceLabels: Record<string, string> = {
    catalogShard: 'Catalog shard',
    catalogRecord: 'Catalog record',
    sourceIds: 'Source records',
    systemId: 'System ID',
    crc32: 'CRC-32',
    md5: 'MD5',
    sha1: 'SHA-1',
    hashSize: 'Hashed size',
    hashMedia: 'Media type',
    hashRepresentation: 'Hash representation',
    serials: 'Serial IDs',
    setIds: 'Set IDs',
    matchEvidence: 'Match result',
    matchProvenance: 'Evidence provenance',
    savedMetadataId: 'Saved metadata record',
    savedMetadataRevision: 'Saved metadata revision',
    verification: 'Verification details',
    romName: 'Catalog filename',
  };
  const human = $derived(humanKeys.flatMap((key) => {
    const value = textValue(metadata[key]).trim();
    return value ? [[humanLabels[key], value] as const] : [];
  }));
  const evidence = $derived(Object.entries(metadata)
    .filter(([key, value]) => !humanKeys.includes(key as (typeof humanKeys)[number]) && value != null && textValue(value).trim())
    .map(([key, value]) => [evidenceLabels[key] ?? readableKey(key), readableValue(key, value)] as const));

  function textValue(value: unknown) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    try { return JSON.stringify(value); } catch { return String(value); }
  }

  function readableKey(key: string) {
    return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase());
  }
  function readableValue(key: string, rawValue: unknown) {
    const value = textValue(rawValue);
    if (key === 'matchEvidence' && value === 'saved-selection') return 'Matches saved game details';
    if (key === 'matchEvidence') {
      const labels: Record<string, string> = {
        'verified-hash': 'Verified ROM checksum',
        'declared-hash': 'Catalog hash match; content not reread',
        'verified-serial': 'Verified game ID',
        'declared-serial': 'Declared game ID match',
        'exact-name': 'Exact filename and edition',
        'hash-conflict': 'Conflicting checksums',
        'serial-conflict': 'Conflicting game IDs',
        'set-alias': 'Known set or filename alias',
        name: 'Filename suggestion',
      };
      return labels[value] ?? value;
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.every(item => ['string','number','boolean'].includes(typeof item)) ? parsed.map(String).join(', ') : JSON.stringify(parsed, null, 2);
    } catch {
      // Keep non-JSON evidence as provided by the matching source.
    }
    return value;
  }
</script>

{#if human.length}<dl class="match-metadata-human">{#each human as [label, value]}<div><dt>{label}</dt><dd>{value}</dd></div>{/each}</dl>{/if}
{#if evidence.length}<details class="matching-evidence"><summary>Match evidence</summary><dl>{#each evidence as [label, value]}<div><dt>{label}</dt><dd>{value}</dd></div>{/each}</dl></details>{/if}

<style>
  dl { margin: var(--space-3) 0; }
  dl > div { margin-top: var(--space-2); }
  dt { color: var(--ink-dim); font-size: var(--text-small); font-weight: var(--weight-semibold); }
  dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .match-metadata-human > div:has(dd) { min-width: 0; }
  .matching-evidence > summary { cursor: pointer; min-height: var(--control-height); color: var(--ink-dim); }
  .matching-evidence dl { margin-bottom: 0; }
</style>
