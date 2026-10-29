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
  let revision = tags
    .map(
      (tag) =>
        /^(?:rev(?:ision)?\.?|ver(?:sion)?\.?|v)\s*([a-z0-9]+(?:\.[a-z0-9]+)*)$/i.exec(tag)?.[1],
    )
    .filter(Boolean)
    .join(',');
  const date = tags.find((tag) => /^\d{4}-\d{2}-\d{2}$/.test(tag)) ?? '';
  let base = stem.replace(/\([^()]*\)|\[[^[\]]*\]/g, ' ').trim();
  const trailingRevision =
    /(?:\s+(?:rev(?:ision)?\.?|ver(?:sion)?\.?)\s+|\s+v(?=\d))([a-z0-9]+(?:\.[a-z0-9]+)*)$/i.exec(
      base,
    );
  if (trailingRevision?.[1]) {
    revision = [...new Set([revision, trailingRevision[1]].filter(Boolean))].join(',');
    base = base.slice(0, trailingRevision.index).trim();
  }
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

/** Exact identifiers allow punctuation/spacing variants, retaining region and revision characters. */
export function normalizeSerial(value: string): string {
  return value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s._()-]/g, '');
}
export function normalizeSetAlias(value: string): string {
  return contentStem(value).normalize('NFKC').toLowerCase().trim();
}
function alternateTitles(value: string): string[] {
  return [
    ...new Set(
      contentStem(value)
        .replace(/\([^()]*\)|\[[^[\]]*\]/g, ' ')
        .trim()
        .split(/\s+(?:~|\/|_)\s+/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}
function canonicalPrimary(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]/gu, '');
}
function equalSets(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}
/** Reconciliation is stricter than suggestion ranking: explicit release facts must agree. */
export function compatibleGameTitles(left: string, right: string): boolean {
  const a = facts(left),
    b = facts(right);
  const alternativesA = alternateTitles(left).map(canonicalPrimary),
    alternativesB = alternateTitles(right).map(canonicalPrimary);
  if (
    (alternativesA.length > 1 || alternativesB.length > 1) &&
    !equalSets(alternativesA, alternativesB)
  )
    return false;
  return (
    nameMatchScore(left, right) > 0 &&
    a.edition === b.edition &&
    a.revision === b.revision &&
    a.date === b.date &&
    (!a.regions.size ||
      !b.regions.size ||
      (a.regions.size === b.regions.size &&
        [...a.regions].every((region) => b.regions.has(region))))
  );
}

/** A verified shared serial can link a full subtitle to its exact short title, never a fuzzy prefix. */
export function serialSubtitleAlias(left: string, right: string): boolean {
  const a = facts(left),
    b = facts(right);
  if (
    a.edition !== b.edition ||
    a.revision !== b.revision ||
    a.date !== b.date ||
    (a.regions.size &&
      b.regions.size &&
      (a.regions.size !== b.regions.size ||
        [...a.regions].some((region) => !b.regions.has(region))))
  )
    return false;
  if (releaseFactsConflict(left, right)) return false;
  const alternativesA = alternateTitles(left),
    alternativesB = alternateTitles(right);
  if (alternativesA.length > 1 || alternativesB.length > 1) {
    if (
      alternativesA.length < 2 ||
      alternativesB.length < 2 ||
      alternativesA.length > 8 ||
      alternativesB.length > 8
    )
      return false;
    const primary = (values: string[]) =>
      values.map((value) => canonicalPrimary(value.split(/\s+[-–—]\s+|:\s+/)[0] ?? value));
    const first = primary(alternativesA),
      second = primary(alternativesB);
    // Every component must survive: do not collapse a compilation to one overlapping title.
    return (
      new Set(first).size === alternativesA.length &&
      new Set(second).size === alternativesB.length &&
      equalSets(first, second)
    );
  }
  const parts = (value: string) => {
    const base = contentStem(value)
      .replace(/\([^()]*\)|\[[^[\]]*\]/g, ' ')
      .trim();
    return { full: key(base), primary: key(base.split(/\s+[-–—]\s+|:\s+/)[0] ?? base) };
  };
  const first = parts(left),
    second = parts(right);
  return first.full === second.primary || second.full === first.primary;
}

/** Explicit release disagreements remain conflicts even when a catalog ROM filename is exact. */
export function releaseFactsConflict(left: string, right: string): boolean {
  const a = facts(left),
    b = facts(right);
  if (
    a.edition !== b.edition ||
    (a.revision && b.revision && a.revision !== b.revision) ||
    (a.date && b.date && a.date !== b.date)
  )
    return true;
  if (
    a.regions.size &&
    b.regions.size &&
    (a.regions.size !== b.regions.size || [...a.regions].some((region) => !b.regions.has(region)))
  )
    return true;
  const languages = (value: string) =>
    new Set(
      Array.from(
        value.matchAll(/\(([^()]*)\)|\[([^[\]]*)\]/g),
        (match) => match[1] ?? match[2] ?? '',
      )
        .flatMap((tag) =>
          tag
            .toLowerCase()
            .split(/[,/]/)
            .map((part) => part.trim()),
        )
        .filter((part) =>
          [
            'en',
            'ja',
            'fr',
            'de',
            'es',
            'it',
            'nl',
            'pt',
            'ko',
            'zh',
            'ru',
            'sv',
            'no',
            'da',
            'fi',
            'el',
            'pl',
            'cs',
            'hu',
            'ar',
          ].includes(part),
        ),
    );
  const first = languages(left),
    second = languages(right);
  return (
    first.size > 0 &&
    second.size > 0 &&
    (first.size !== second.size || [...first].some((language) => !second.has(language)))
  );
}
