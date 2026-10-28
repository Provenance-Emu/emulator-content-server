/** Filename hints only. This never provides checksum evidence or permission to auto-save. */
export function contentStem(name: string): string {
  return name.replace(
    /\.(?:zip|7z|chd|cdi|iso|cue|gdi|ccd|m3u|bin|rom|j64|jag|abs|cof|nes|sfc|smc|gb|gbc|gba|n64|z64|v64|md|gen|sms|gg|png)$/i,
    '',
  );
}
function key(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .trim()
    .replace(/\p{M}/gu, '')
    .replace(/&/g, 'and')
    .replace(/(?:^the\s+|,\s*the$)/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}
interface NameFacts {
  exact: string;
  bases: string[];
  regions: Set<string>;
  edition: string;
  revision: string;
  date: string;
}
const cache = new Map<string, NameFacts>();
function facts(name: string): NameFacts {
  const cached = cache.get(name);
  if (cached) return cached;
  const stem = contentStem(name).normalize('NFKC').toLowerCase();
  const tags = Array.from(stem.matchAll(/\(([^()]*)\)|\[([^[\]]*)\]/g), (m) => m[1] ?? m[2] ?? '');
  const regions = new Set<string>();
  for (const tag of tags)
    for (const part of tag.split(/[,/]/).map((p) => p.trim())) {
      const region: Record<string, string> = {
        usa: 'us',
        us: 'us',
        u: 'us',
        na: 'us',
        japan: 'jp',
        jp: 'jp',
        jpn: 'jp',
        j: 'jp',
        europe: 'eu',
        eu: 'eu',
        e: 'eu',
        world: 'world',
        w: 'world',
        korea: 'kr',
        kor: 'kr',
        australia: 'au',
        brazil: 'br',
      };
      const knownRegion = region[part];
      if (knownRegion) regions.add(knownRegion);
    }
  const edition = tags
    .map((tag) =>
      /\b(alpha|beta|proto(?:type)?|demo|hack)\b/.exec(tag)?.[1]?.replace('prototype', 'proto'),
    )
    .filter(Boolean)
    .sort()
    .join(',');
  const revision = tags
    .map(
      (tag) =>
        /^(?:rev(?:ision)?\.?|ver(?:sion)?\.?|v)\s*([a-z0-9]+(?:\.[a-z0-9]+)*)$/i.exec(tag)?.[1],
    )
    .filter(Boolean)
    .join(',');
  const date = tags.find((tag) => /^\d{4}-\d{2}-\d{2}$/.test(tag)) ?? '';
  const base = stem.replace(/\([^()]*\)|\[[^[\]]*\]/g, ' ').trim();
  const value: NameFacts = {
    exact: key(stem),
    bases: [...new Set([base, ...base.split(/\s+(?:~|\/|_)\s+/)].map(key).filter(Boolean))],
    regions,
    edition,
    revision,
    date,
  };
  if (cache.size >= 8192) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(name, value);
  return value;
}
/** Coarse candidate buckets; callers still use nameMatchScore for edition/region evidence. */
export function nameMatchKeys(value: string): readonly string[] {
  return facts(value).bases;
}
export function nameMatchScore(left: string, right: string): number {
  const a = facts(left),
    b = facts(right);
  if (!a.bases.some((base) => b.bases.includes(base)) || a.edition !== b.edition) return 0;
  if (a.revision && b.revision && a.revision !== b.revision) return 0;
  if (a.date && b.date && a.date !== b.date) return 0;
  if (
    a.regions.size &&
    b.regions.size &&
    !a.regions.has('world') &&
    !b.regions.has('world') &&
    ![...a.regions].some((r) => b.regions.has(r))
  )
    return 0;
  return a.exact === b.exact ? 100 : a.regions.size && b.regions.size ? 90 : 80;
}
