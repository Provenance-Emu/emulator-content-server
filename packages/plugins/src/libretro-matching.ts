import { parseFlycastCatalog } from './arcade-catalog.js';
import {
  JAGUAR_CD_ARTWORK,
  jaguarCdArtworkAliases,
  jaguarCdArtworkReview,
} from './jaguar-cd-artwork.js';
import {
  automaticEvidence,
  classifyArtwork,
  compatibleCatalogIdentity,
  createLibretroMatcher,
  type DatRecord,
  type MatchCandidate,
  type MatchingInput,
  type MatchingProvider,
  type matchLibretro,
  PartialMatchingError,
  parseLibretroDat,
  reconcileCandidates,
  selectedArtworkAnchor,
} from './matching.js';
import {
  artworkTitleMatches,
  contentStem,
  nameMatchKeys,
  nameMatchScore,
  normalizeSerial,
} from './matching-names.js';
import { createCatalogLoader } from './public-catalog.js';

interface SystemCatalog {
  platform: string;
  collection?: string;
  arcade?: boolean;
  artworkRepo?: string;
  branch?: string;
  frontsOnly?: boolean;
}
export const LIBRETRO_SYSTEMS: Record<string, SystemCatalog> = {
  'com.provenance.2600': { platform: 'Atari - 2600', collection: 'no-intro' },
  'com.provenance.5200': { platform: 'Atari - 5200', collection: 'no-intro' },
  'com.provenance.7800': { platform: 'Atari - 7800', collection: 'no-intro' },
  'com.provenance.lynx': { platform: 'Atari - Lynx', collection: 'no-intro' },
  'com.provenance.vb': { platform: 'Nintendo - Virtual Boy', collection: 'no-intro' },
  'com.provenance.fds': {
    platform: 'Nintendo - Family Computer Disk System',
    collection: 'no-intro',
  },
  'com.provenance.pce': { platform: 'NEC - PC Engine - TurboGrafx 16', collection: 'no-intro' },
  'com.provenance.sgfx': { platform: 'NEC - PC Engine SuperGrafx', collection: 'no-intro' },
  'com.provenance.pcecd': { platform: 'NEC - PC Engine CD - TurboGrafx-CD', collection: 'redump' },
  'com.provenance.pcfx': { platform: 'NEC - PC-FX', collection: 'redump' },
  'com.provenance.ws': { platform: 'Bandai - WonderSwan', collection: 'no-intro' },
  'com.provenance.wsc': { platform: 'Bandai - WonderSwan Color', collection: 'no-intro' },
  'com.provenance.ngp': { platform: 'SNK - Neo Geo Pocket', collection: 'no-intro' },
  'com.provenance.ngpc': { platform: 'SNK - Neo Geo Pocket Color', collection: 'no-intro' },
  'com.provenance.32X': { platform: 'Sega - 32X', collection: 'no-intro' },
  'com.provenance.segacd': { platform: 'Sega - Mega-CD - Sega CD', collection: 'redump' },
  'com.provenance.sg1000': { platform: 'Sega - SG-1000', collection: 'no-intro' },
  'com.provenance.ds': { platform: 'Nintendo - Nintendo DS' },
  'com.provenance.3ds': { platform: 'Nintendo - Nintendo 3DS' },
  'com.provenance.ps2': { platform: 'Sony - PlayStation 2' },
  'com.provenance.3DO': { platform: 'The 3DO Company - 3DO', collection: 'redump' },
  'com.provenance.neogeo': { platform: 'SNK - Neo Geo' },
  'com.provenance.neogeocd': { platform: 'SNK - Neo Geo CD', collection: 'redump' },
  'com.provenance.mame': { platform: 'MAME', frontsOnly: true },
  'com.provenance.colecovision': { platform: 'Coleco - ColecoVision', collection: 'no-intro' },
  'com.provenance.intellivision': { platform: 'Mattel - Intellivision', collection: 'no-intro' },
  'com.provenance.odyssey2': { platform: 'Magnavox - Odyssey2', collection: 'no-intro' },
  'com.provenance.vectrex': { platform: 'GCE - Vectrex', collection: 'no-intro' },
  'com.provenance.pokemonmini': { platform: 'Nintendo - Pokemon Mini', collection: 'no-intro' },
  'com.provenance.supervision': { platform: 'Watara - Supervision', collection: 'no-intro' },
  'com.provenance.atari8bit': { platform: 'Atari - 8-bit Family', collection: 'no-intro' },
  'com.provenance.atarist': { platform: 'Atari - ST', collection: 'no-intro' },
  'com.provenance.c64': { platform: 'Commodore - 64' },
  'com.provenance.cdi': { platform: 'Philips - CD-i', collection: 'redump' },
  'com.provenance.msx': { platform: 'Microsoft - MSX', collection: 'no-intro' },
  'com.provenance.msx2': { platform: 'Microsoft - MSX2', collection: 'no-intro' },
  'com.provenance.pc98': { platform: 'NEC - PC-98', collection: 'redump' },
  'com.provenance.dos': { platform: 'DOS' },
  'com.provenance.doom': { platform: 'DOOM' },
  'com.provenance.wolf3d': { platform: 'Wolfenstein 3D' },
  'com.provenance.quake': { platform: 'Quake' },
  'com.provenance.quake2': { platform: 'Quake II' },
  'com.provenance.tic80': { platform: 'TIC-80' },
  'com.provenance.cps1': { platform: 'FBNeo - Arcade Games', frontsOnly: true },
  'com.provenance.cps2': { platform: 'FBNeo - Arcade Games', frontsOnly: true },
  'com.provenance.cps3': { platform: 'FBNeo - Arcade Games', frontsOnly: true },
  'com.provenance.jaguar': { platform: 'Atari - Jaguar', collection: 'no-intro' },
  'com.provenance.jaguarcd': {
    platform: 'Atari - Jaguar CD',
    collection: 'redump',
    artworkRepo: 'Atari_-_Jaguar_CD',
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
  'com.provenance.gamecube': { platform: 'Nintendo - GameCube', collection: 'redump' },
  'com.provenance.wii': { platform: 'Nintendo - Wii', collection: 'redump' },
  'com.provenance.psp': { platform: 'Sony - PlayStation Portable', collection: 'redump' },
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
  repository?: string;
  source?: string;
  originalTitle?: string;
  review?: string;
  title: string;
  path: string;
  kind: string;
  sha: string;
  role: ReturnType<typeof classifyArtwork>['role'];
  blobSha?: string;
  bytes: number;
}
function artworkIndex(text: string, mirror = false): Artwork[] {
  const data = JSON.parse(text) as { sha?: unknown; truncated?: unknown; tree?: unknown };
  if (
    typeof data.sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(data.sha) ||
    (mirror && data.sha !== JAGUAR_CD_ARTWORK.revision) ||
    data.truncated ||
    !Array.isArray(data.tree) ||
    data.tree.length > 30000
  )
    throw new Error('Incomplete artwork catalog');
  const sha = data.sha;
  return data.tree
    .flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const row = entry as { path?: unknown; type?: unknown; size?: unknown; sha?: unknown };
      if (
        row.type !== 'blob' ||
        typeof row.path !== 'string' ||
        typeof row.size !== 'number' ||
        row.size < 32 ||
        row.size > 2 * 1024 * 1024
      )
        return [];
      if (mirror && !row.path.startsWith(JAGUAR_CD_ARTWORK.prefix)) return [];
      const relativePath = mirror ? row.path.slice(JAGUAR_CD_ARTWORK.prefix.length) : row.path;
      const match = /^Named_(Boxarts|Titles|Snaps)\/([^/\\\0]{1,512})\.png$/i.exec(relativePath);
      return match?.[1] && match[2]
        ? [
            {
              title: match[2],
              path: row.path,
              kind: match[1].toLowerCase(),
              sha,
              role: classifyArtwork(relativePath).role,
              ...(mirror
                ? {
                    repository: JAGUAR_CD_ARTWORK.repository,
                    source: JAGUAR_CD_ARTWORK.source,
                    originalTitle: match[2],
                    ...(match[1].toLowerCase() === 'boxarts'
                      ? { review: jaguarCdArtworkReview(match[2]) }
                      : {}),
                  }
                : {}),
              bytes: row.size,
              ...(typeof row.sha === 'string' && /^[a-f0-9]{40}$/.test(row.sha)
                ? { blobSha: row.sha }
                : {}),
            },
          ]
        : [];
    })
    .flatMap((image) =>
      mirror
        ? [image, ...jaguarCdArtworkAliases(image.title).map((title) => ({ ...image, title }))]
        : [image],
    );
}

/** Public facts/indexes only: ROM bytes, local paths and credentials never leave the server. */
export function createLibretroProvider(
  fetcher: typeof fetch = fetch,
  cacheDirectory?: string,
  metadataResolver?: (
    input: MatchingInput,
    signal?: AbortSignal,
  ) => Promise<MatchCandidate[] | null>,
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
      let resolvedMetadata: MatchCandidate[] | null = null;
      if (metadataResolver) {
        try {
          resolvedMetadata = await metadataResolver(lookupInput, resourceSignal);
        } catch (error) {
          signal?.throwIfAborted();
          failures.push(error);
          resolvedMetadata = [];
        }
      }
      const tables: Promise<DatRecord[]>[] = [];
      if (resolvedMetadata === null && system.collection)
        tables.push(
          dat(
            `https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/${system.collection}/${encodeURIComponent(system.platform)}.dat`,
          ),
        );
      if (resolvedMetadata === null && systemId === 'com.provenance.jaguar')
        tables.push(
          dat(
            'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/tosec/Atari%20-%20Jaguar.dat',
          ),
        );
      if (resolvedMetadata === null && systemId === 'com.provenance.atomiswave')
        tables.push(
          dat(
            'https://raw.githubusercontent.com/libretro/libretro-database/master/dat/Atomiswave.dat',
            true,
          ),
        );
      if (resolvedMetadata === null && system.arcade)
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
          if (system.frontsOnly) {
            const root = await catalogs.load(
              `https://api.github.com/repos/libretro-thumbnails/${repo}/git/trees/${system.branch ?? 'master'}`,
              resourceSignal,
              256 * 1024,
            );
            if (!root) return emptyArt;
            const data = JSON.parse(root) as {
              sha?: string;
              truncated?: boolean;
              tree?: { path?: string; type?: string; sha?: string }[];
            };
            if (
              !data.sha ||
              !/^[a-f0-9]{40}$/.test(data.sha) ||
              data.truncated ||
              !Array.isArray(data.tree) ||
              data.tree.length > 128
            )
              throw new Error('Incomplete artwork root');
            const directory = data.tree.find(
              (row) => row.path === 'Named_Boxarts' && row.type === 'tree',
            );
            if (!directory) return emptyArt;
            if (!directory.sha || !/^[a-f0-9]{40}$/.test(directory.sha))
              throw new Error('Invalid artwork subtree');
            const index = await catalogs.load(
              `https://api.github.com/repos/libretro-thumbnails/${repo}/git/trees/${directory.sha}`,
              resourceSignal,
              8 * 1024 * 1024,
            );
            if (!index) throw new Error('Artwork subtree unavailable');
            return memo(`art:${repo}:fronts`, `${root}\n${index}`, () => {
              const child = JSON.parse(index) as {
                sha?: string;
                truncated?: boolean;
                tree?: { path?: string }[];
              };
              if (
                child.sha !== directory.sha ||
                child.truncated ||
                !Array.isArray(child.tree) ||
                child.tree.length > 30000
              )
                throw new Error('Incomplete artwork subtree');
              return artworkIndex(
                JSON.stringify({
                  ...child,
                  sha: data.sha,
                  tree: child.tree
                    .filter((row) => typeof row.path === 'string' && !/[/\\\0]/.test(row.path))
                    .map((row) => ({ ...row, path: `Named_Boxarts/${row.path}` })),
                }),
              );
            });
          }
          const index = await catalogs.load(
            `https://api.github.com/repos/libretro-thumbnails/${repo}/git/trees/${system.branch ?? 'master'}?recursive=1`,
            resourceSignal,
            8 * 1024 * 1024,
          );
          if (index) return memo(`art:${repo}`, index, () => artworkIndex(index));
          if (systemId !== 'com.provenance.jaguarcd') return emptyArt;
          const mirror = await catalogs.load(
            `https://api.github.com/repos/${JAGUAR_CD_ARTWORK.repository}/git/trees/${JAGUAR_CD_ARTWORK.revision}?recursive=1`,
            resourceSignal,
            8 * 1024 * 1024,
          );
          return mirror
            ? memo('art:jaguar-cd-mirror', mirror, () => artworkIndex(mirror, true))
            : emptyArt;
        } catch (error) {
          failures.push(error);
          return emptyArt;
        }
      })();
      const [records, artworks] = await Promise.all([Promise.all(tables), indexed]);
      const metadata = resolvedMetadata ?? match(lookupInput, records);
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
      const selected = selectedArtworkAnchor(lookupInput);
      const names = [
        ...(selected?.titles ?? []),
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
          !row.image.review &&
          verified.has(`${systemId}\0${canonical(row.image.title)}`),
      );
      const uniqueCovers = <T extends { image: Artwork }>(covers: T[]): T[] => [
        ...new Map(
          covers.map((row) => [
            row.image.blobSha
              ? `blob:${row.image.blobSha}:${row.image.bytes}`
              : `path:${row.image.path}`,
            row,
          ]),
        ).values(),
      ];
      const distinctBoxarts = uniqueCovers(boxarts);
      const onlyCover = distinctBoxarts.length === 1 ? distinctBoxarts[0] : undefined;
      const identity = onlyCover
        ? verified.get(`${systemId}\0${canonical(onlyCover.image.title)}`)
        : undefined;
      const canonicalCover =
        !failures.length && consistent && onlyCover && identity && systemId
          ? { index: onlyCover.index, title: identity.canonicalTitle, systemId, identity }
          : undefined;
      const exactSelectedCovers = selected
        ? ranked.filter(
            (row) =>
              row.image.kind === 'boxarts' &&
              !row.image.review &&
              selected.titles.some((title) => canonical(title) === canonical(row.image.title)),
          )
        : [];
      const selectedCovers = exactSelectedCovers.length
        ? exactSelectedCovers
        : selected
          ? ranked.filter(
              (row) =>
                row.image.kind === 'boxarts' &&
                !row.image.review &&
                selected.titles.some((title) => artworkTitleMatches(title, row.image.title)),
            )
          : [];
      const distinctSelectedCovers = uniqueCovers(selectedCovers);
      const selectedCover =
        !failures.length && selected && distinctSelectedCovers.length === 1
          ? distinctSelectedCovers[0]
          : undefined;
      const art = ranked.slice(0, 24).map(({ image, index }): MatchCandidate => {
        const corroborated = canonicalCover?.index === index ? canonicalCover : undefined;
        const candidate: MatchCandidate = {
          id: `art-${index}`,
          kind: 'artwork',
          title: image.title,
          confidence: corroborated?.identity.confidence === 'checksum' ? 'checksum' : 'name',
          url: `https://raw.githubusercontent.com/${image.repository ?? `libretro-thumbnails/${repo}`}/${image.sha}/${image.path
            .split('/')
            .map((segment) => encodeURIComponent(segment))
            .join('/')}`,
          metadata: {
            source: image.source ?? 'Libretro thumbnails',
            ...(image.originalTitle
              ? {
                  artworkCatalogTitle: image.originalTitle,
                  artworkNotice: JAGUAR_CD_ARTWORK.notice,
                }
              : {}),
            ...(image.review
              ? { artworkReviewRequired: 'true', artworkReviewReason: image.review }
              : {}),
            artworkType: image.kind,
            artworkRole: image.role,
            ...(image.blobSha
              ? { artworkBlobSha1: image.blobSha, artworkBytes: String(image.bytes) }
              : {}),
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
        if (
          !corroborated &&
          selected &&
          selectedCover?.index === index &&
          lookupInput.selectedMetadata
        ) {
          Object.assign(
            candidate.metadata,
            Object.fromEntries(
              Object.entries(selected.identity.metadata).filter(([key]) =>
                [
                  'md5',
                  'sha1',
                  'crc32',
                  'hashSize',
                  'hashMedia',
                  'hashRepresentation',
                  'serials',
                  'setIds',
                  'matchProvenance',
                ].includes(key),
              ),
            ),
            {
              matchedGame: selected.identity.title,
              matchEvidence: 'saved-selection',
              savedMetadataId: lookupInput.selectedMetadata.id,
              savedMetadataRevision: String(lookupInput.selectedMetadata.revision),
              verification:
                'Canonical front for the saved metadata choice; no new ROM checksum verification claimed',
            },
          );
        }
        if (
          !corroborated &&
          candidate.metadata.matchEvidence !== 'saved-selection' &&
          !failures.length &&
          automaticEvidence(lookupInput, candidate)
        ) {
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
