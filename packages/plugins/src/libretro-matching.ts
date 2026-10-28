import { parseFlycastCatalog } from './arcade-catalog.js';
import {
  automaticEvidence,
  classifyArtwork,
  compatibleCatalogIdentity,
  createLibretroMatcher,
  type DatRecord,
  type MatchCandidate,
  type MatchingProvider,
  type matchLibretro,
  PartialMatchingError,
  parseLibretroDat,
  reconcileCandidates,
} from './matching.js';
import { contentStem, nameMatchKeys, nameMatchScore, normalizeSerial } from './matching-names.js';
import { createCatalogLoader } from './public-catalog.js';

interface SystemCatalog {
  platform: string;
  collection?: string;
  arcade?: boolean;
  artworkRepo?: string;
  branch?: string;
}
export const LIBRETRO_SYSTEMS: Record<string, SystemCatalog> = {
  'com.provenance.jaguar': { platform: 'Atari - Jaguar', collection: 'no-intro' },
  'com.provenance.jaguarcd': {
    platform: 'Atari - Jaguar CD',
    collection: 'redump',
    artworkRepo: 'Atari_-_Jaguar',
  },
  'com.provenance.nes': {
    platform: 'Nintendo - Nintendo Entertainment System',
    collection: 'no-intro',
  },
  'com.provenance.snes': {
    platform: 'Nintendo - Super Nintendo Entertainment System',
    collection: 'no-intro',
  },
  'com.provenance.gb': { platform: 'Nintendo - Game Boy', collection: 'no-intro' },
  'com.provenance.gbc': { platform: 'Nintendo - Game Boy Color', collection: 'no-intro' },
  'com.provenance.gba': { platform: 'Nintendo - Game Boy Advance', collection: 'no-intro' },
  'com.provenance.n64': { platform: 'Nintendo - Nintendo 64', collection: 'no-intro' },
  'com.provenance.genesis': { platform: 'Sega - Mega Drive - Genesis', collection: 'no-intro' },
  'com.provenance.mastersystem': {
    platform: 'Sega - Master System - Mark III',
    collection: 'no-intro',
  },
  'com.provenance.gamegear': { platform: 'Sega - Game Gear', collection: 'no-intro' },
  'com.provenance.psx': { platform: 'Sony - PlayStation', collection: 'redump' },
  'com.provenance.saturn': { platform: 'Sega - Saturn', collection: 'redump' },
  'com.provenance.dreamcast': { platform: 'Sega - Dreamcast', collection: 'redump' },
  'com.provenance.naomi': {
    platform: 'Sega - Naomi',
    collection: 'redump',
    arcade: true,
    branch: 'main',
  },
  'com.provenance.naomi2': {
    platform: 'Sega - Naomi 2',
    collection: 'redump',
    arcade: true,
    branch: 'main',
  },
  'com.provenance.atomiswave': { platform: 'Atomiswave', arcade: true },
};
const FLYCAST =
  'https://raw.githubusercontent.com/flyinghead/flycast/master/core/hw/naomi/naomi_roms.cpp';
interface Artwork {
  title: string;
  path: string;
  kind: string;
  sha: string;
  role: ReturnType<typeof classifyArtwork>['role'];
}
function artworkIndex(text: string): Artwork[] {
  const data = JSON.parse(text) as { sha?: unknown; truncated?: unknown; tree?: unknown };
  if (
    typeof data.sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(data.sha) ||
    data.truncated ||
    !Array.isArray(data.tree) ||
    data.tree.length > 30000
  )
    throw new Error('Incomplete artwork catalog');
  const sha = data.sha;
  return data.tree.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as { path?: unknown; type?: unknown; size?: unknown };
    if (
      row.type !== 'blob' ||
      typeof row.path !== 'string' ||
      typeof row.size !== 'number' ||
      row.size < 32 ||
      row.size > 2 * 1024 * 1024
    )
      return [];
    const match = /^Named_(Boxarts|Titles|Snaps)\/([^/\\\0]{1,512})\.png$/i.exec(row.path);
    return match?.[1] && match[2]
      ? [
          {
            title: match[2],
            path: row.path,
            kind: match[1].toLowerCase(),
            sha,
            role: classifyArtwork(row.path).role,
          },
        ]
      : [];
  });
}

/** Public facts/indexes only: ROM bytes, local paths and credentials never leave the server. */
export function createLibretroProvider(
  fetcher: typeof fetch = fetch,
  cacheDirectory?: string,
): MatchingProvider {
  const catalogs = createCatalogLoader(fetcher, cacheDirectory);
  const emptyRecords: DatRecord[] = [],
    emptyArt: Artwork[] = [];
  const parsed = new Map<string, { text: string; value: unknown; weight: number }>();
  const compiled = new Map<
    string,
    {
      tables: DatRecord[][];
      match: (input: Parameters<typeof matchLibretro>[0]) => MatchCandidate[];
    }
  >();
  const artBuckets = new WeakMap<Artwork[], Map<string, number[]>>();
  let parsedBytes = 0;
  function memo<T extends DatRecord[] | Artwork[]>(key: string, text: string, parser: () => T): T {
    const cached = parsed.get(key);
    if (cached?.text === text) {
      parsed.delete(key);
      parsed.set(key, cached);
      return cached.value as T;
    }
    if (cached) {
      parsed.delete(key);
      parsedBytes -= cached.weight;
      compiled.clear();
    }
    const value = parser();
    const weight =
      text.length * 2 +
      value.reduce(
        (sum, row) =>
          sum +
          512 +
          row.title.length * 2 +
          ('name' in row
            ? row.name.length * 2 + (row.aliases ?? []).join('').length * 2
            : row.path.length * 2),
        0,
      );
    if (weight <= 64 * 1024 * 1024) {
      parsed.set(key, { text, value, weight });
      parsedBytes += weight;
      while (parsed.size > 8 || parsedBytes > 64 * 1024 * 1024) {
        const oldest = parsed.keys().next().value;
        if (oldest === undefined) break;
        parsedBytes -= parsed.get(oldest)?.weight ?? 0;
        parsed.delete(oldest);
        compiled.clear();
      }
    }
    return value;
  }
  function match(
    input: Parameters<typeof matchLibretro>[0],
    tables: DatRecord[][],
  ): MatchCandidate[] {
    const key = input.systemId ?? '<inferred>';
    let entry = compiled.get(key);
    if (
      !entry ||
      entry.tables.length !== tables.length ||
      entry.tables.some((table, index) => table !== tables[index])
    ) {
      entry = { tables, match: createLibretroMatcher(tables.flat()) };
      compiled.delete(key);
      // An index can retain only datasets already accounted for by the parsed LRU.
      if (
        tables.every(
          (table) =>
            table === emptyRecords || [...parsed.values()].some((cached) => cached.value === table),
        )
      )
        compiled.set(key, entry);
      if (compiled.size > 8) compiled.delete(compiled.keys().next().value ?? '');
    }
    return entry.match(input);
  }
  function imagesFor(images: Artwork[], names: string[]): Array<{ image: Artwork; index: number }> {
    let buckets = artBuckets.get(images);
    if (!buckets) {
      buckets = new Map();
      images.forEach((image, index) => {
        for (const key of nameMatchKeys(image.title)) {
          const indices = buckets?.get(key) ?? [];
          indices.push(index);
          buckets?.set(key, indices);
        }
      });
      artBuckets.set(images, buckets);
    }
    const indices = new Set<number>();
    for (const name of names)
      for (const key of nameMatchKeys(name))
        for (const index of buckets.get(key) ?? []) indices.add(index);
    return [...indices]
      .sort((a, b) => a - b)
      .flatMap((index) => {
        const image = images[index];
        return image ? [{ image, index }] : [];
      });
  }
  return {
    id: 'org.ecs.libretro',
    name: 'Game catalogs and artwork',
    capabilities: ['metadata', 'artwork'],
    network: true,
    async search(input, signal) {
      if (!input.online) return [];
      let systemId = input.systemId;
      let system = systemId ? LIBRETRO_SYSTEMS[systemId] : undefined;
      let inferred: DatRecord[] | null = null;
      let inferredText = '';
      if (!system && systemId === null) {
        try {
          const text = await catalogs.load(FLYCAST, signal, 4 * 1024 * 1024);
          inferredText = text ?? '';
          inferred = text ? memo(FLYCAST, text, () => parseFlycastCatalog(text)) : emptyRecords;
          const hints = match(input, [inferred]);
          const systems = new Set(hints.map((candidate) => candidate.metadata.systemId));
          if (systems.size !== 1) return hints;
          systemId = [...systems][0] ?? null;
          system = systemId ? LIBRETRO_SYSTEMS[systemId] : undefined;
        } catch {
          signal?.throwIfAborted();
          throw new PartialMatchingError([]);
        }
      }
      if (!system) return [];
      const lookupInput = { ...input, systemId };
      const failures: unknown[] = [];
      const resourceSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(6500)])
        : AbortSignal.timeout(6500);
      const repo = system.artworkRepo ?? system.platform.replaceAll(' ', '_');
      async function dat(url: string, arcade = false): Promise<DatRecord[]> {
        try {
          const text = await catalogs.load(url, resourceSignal);
          return text
            ? memo(`${url}:${arcade ? systemId : ''}`, text, () =>
                parseLibretroDat(text).map((record) =>
                  arcade
                    ? {
                        ...record,
                        systemId: systemId ?? undefined,
                        source: 'Libretro arcade catalog',
                      }
                    : record,
                ),
              )
            : emptyRecords;
        } catch (error) {
          failures.push(error);
          return emptyRecords;
        }
      }
      const tables: Promise<DatRecord[]>[] = [];
      if (system.collection)
        tables.push(
          dat(
            `https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/${system.collection}/${encodeURIComponent(system.platform)}.dat`,
          ),
        );
      if (systemId === 'com.provenance.jaguar')
        tables.push(
          dat(
            'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/tosec/Atari%20-%20Jaguar.dat',
          ),
        );
      if (systemId === 'com.provenance.atomiswave')
        tables.push(
          dat(
            'https://raw.githubusercontent.com/libretro/libretro-database/master/dat/Atomiswave.dat',
            true,
          ),
        );
      if (system.arcade)
        tables.push(
          (async () => {
            try {
              const text = inferred
                ? null
                : await catalogs.load(FLYCAST, resourceSignal, 4 * 1024 * 1024);
              if (inferred) {
                const source = inferred;
                return memo(`${FLYCAST}:${systemId}`, inferredText, () =>
                  source.filter((record) => record.systemId === systemId),
                );
              }
              return text
                ? memo(`${FLYCAST}:${systemId}`, text, () =>
                    parseFlycastCatalog(text).filter((record) => record.systemId === systemId),
                  )
                : emptyRecords;
            } catch (error) {
              failures.push(error);
              return emptyRecords;
            }
          })(),
        );
      const indexed = (async (): Promise<Artwork[]> => {
        try {
          const index = await catalogs.load(
            `https://api.github.com/repos/libretro-thumbnails/${repo}/git/trees/${system.branch ?? 'master'}?recursive=1`,
            resourceSignal,
            8 * 1024 * 1024,
          );
          return index ? memo(`art:${repo}`, index, () => artworkIndex(index)) : emptyArt;
        } catch (error) {
          failures.push(error);
          return emptyArt;
        }
      })();
      const [records, artworks] = await Promise.all([Promise.all(tables), indexed]);
      const metadata = match(lookupInput, records);
      signal?.throwIfAborted();
      // A checksum can establish the public title even when the original file was renamed.
      // Filename-only suggestions stay bounded and region/edition-aware for explicit review.
      const aliases = (candidate: MatchCandidate): string[] => {
        try {
          const rows: unknown = JSON.parse(candidate.metadata.matchProvenance ?? '[]');
          return Array.isArray(rows)
            ? rows.flatMap((row) =>
                row && typeof row === 'object' && 'title' in row && typeof row.title === 'string'
                  ? [row.title]
                  : [],
              )
            : [];
        } catch {
          return [];
        }
      };
      const serialArtworkAliases = (candidate: MatchCandidate): string[] => {
        if (!automaticEvidence(lookupInput, candidate)) return [];
        const verifiedSerials = (input.facts?.identifiers ?? []).filter(
          (id) =>
            id.type === 'serial' &&
            id.verified &&
            (!id.systemId || id.systemId === candidate.metadata.systemId),
        );
        const declared = ['serials', 'setIds'].flatMap((key) => {
          try {
            const values: unknown = JSON.parse(candidate.metadata[key] ?? '[]');
            return Array.isArray(values) && values.length <= 32
              ? values.filter(
                  (value): value is string => typeof value === 'string' && value.length <= 160,
                )
              : [];
          } catch {
            return [];
          }
        });
        return [
          ...new Set(
            declared
              .filter((value) =>
                verifiedSerials.some((id) => normalizeSerial(id.value) === normalizeSerial(value)),
              )
              .flatMap((value) =>
                [candidate.title, ...aliases(candidate)].map((title) => `${title} (${value})`),
              ),
          ),
        ];
      };
      const names = [
        input.name,
        ...(input.facts?.names ?? []),
        ...metadata.flatMap((candidate) => [
          candidate.title,
          ...aliases(candidate),
          ...serialArtworkAliases(candidate),
        ]),
      ];
      const ranked = imagesFor(artworks, names)
        .map(({ image, index }) => ({
          image,
          index,
          score: Math.max(...names.map((name) => nameMatchScore(name, image.title))),
        }))
        .filter((row) => row.score > 0)
        .sort(
          (a, b) =>
            (({ boxarts: 0, titles: 1, snaps: 2 })[a.image.kind] ?? 3) -
              ({ boxarts: 0, titles: 1, snaps: 2 }[b.image.kind] ?? 3) ||
            b.score - a.score ||
            a.image.path.localeCompare(b.image.path),
        );
      // This corroborates game identity, not a checksum of the image bytes.
      const canonical = (title: string) =>
        title
          .normalize('NFC')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\p{M}]/gu, '');
      const verified = new Map(
        metadata
          .filter((candidate) =>
            automaticEvidence({ ...lookupInput, allowExactNames: false }, candidate),
          )
          .flatMap((candidate) =>
            [candidate.title, ...aliases(candidate), ...serialArtworkAliases(candidate)].map(
              (title) =>
                [
                  `${candidate.metadata.systemId}\0${canonical(title)}`,
                  { ...candidate, title, canonicalTitle: candidate.title },
                ] as const,
            ),
          ),
      );
      // Independent DATs may name identical verified bytes using regional and
      // legacy titles. All aliases must agree on game, system and edition facts.
      const identities = [...verified.values()];
      const consistent =
        identities.length > 0 &&
        identities.every(
          (left) =>
            left.metadata.systemId === systemId &&
            identities.every((right) => compatibleCatalogIdentity(lookupInput, left, right)),
        );
      const boxarts = ranked.filter(
        (row) =>
          row.image.kind === 'boxarts' &&
          verified.has(`${systemId}\0${canonical(row.image.title)}`),
      );
      const onlyCover = boxarts.length === 1 ? boxarts[0] : undefined;
      const identity = onlyCover
        ? verified.get(`${systemId}\0${canonical(onlyCover.image.title)}`)
        : undefined;
      const canonicalCover =
        !failures.length && consistent && onlyCover && identity && systemId
          ? { index: onlyCover.index, title: identity.canonicalTitle, systemId, identity }
          : undefined;
      const art = ranked.slice(0, 24).map(({ image, index }): MatchCandidate => {
        const corroborated = canonicalCover?.index === index ? canonicalCover : undefined;
        const candidate: MatchCandidate = {
          id: `art-${index}`,
          kind: 'artwork',
          title: image.title,
          confidence: corroborated?.identity.confidence === 'checksum' ? 'checksum' : 'name',
          url: `https://raw.githubusercontent.com/libretro-thumbnails/${repo}/${image.sha}/${image.path
            .split('/')
            .map((segment) => encodeURIComponent(segment))
            .join('/')}`,
          metadata: {
            source: 'Libretro thumbnails',
            artworkType: image.kind,
            artworkRole: image.role,
            matchedGame: corroborated?.title ?? contentStem(input.name),
            ...(systemId ? { systemId } : {}),
            ...(corroborated
              ? {
                  ...Object.fromEntries(
                    Object.entries(corroborated.identity.metadata).filter(([key]) =>
                      [
                        'md5',
                        'sha1',
                        'crc32',
                        'hashSize',
                        'hashMedia',
                        'hashRepresentation',
                        'serials',
                        'setIds',
                        'matchEvidence',
                        'matchProvenance',
                      ].includes(key),
                    ),
                  ),
                  systemId: corroborated.systemId,
                  verification:
                    corroborated.identity.confidence === 'checksum'
                      ? 'Canonical cover for ROM checksum-verified game identity; image checksum not compared'
                      : 'Canonical cover for byte-read serial-verified game identity; image checksum not compared',
                }
              : {}),
            availability: 'Listed in public artwork catalog; image checked on preview',
          },
        };
        if (!corroborated && !failures.length && automaticEvidence(lookupInput, candidate)) {
          candidate.metadata.matchEvidence = 'exact-name';
          candidate.metadata.verification =
            'Exact full filename and catalog front title; no checksum or serial verification claimed';
        }
        return candidate;
      });
      const candidates = reconcileCandidates(lookupInput, [...metadata, ...art]);
      if (failures.length) throw new PartialMatchingError(candidates);
      return candidates;
    },
  };
}
