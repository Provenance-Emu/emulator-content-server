import { parseFlycastCatalog } from './arcade-catalog.js';
import {
  type DatRecord,
  type MatchCandidate,
  type MatchingProvider,
  matchLibretro,
  PartialMatchingError,
  parseLibretroDat,
} from './matching.js';
import { contentStem, nameMatchScore } from './matching-names.js';
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
      ? [{ title: match[2], path: row.path, kind: match[1].toLowerCase(), sha }]
      : [];
  });
}

/** Public facts/indexes only: ROM bytes, local paths and credentials never leave the server. */
export function createLibretroProvider(
  fetcher: typeof fetch = fetch,
  cacheDirectory?: string,
): MatchingProvider {
  const catalogs = createCatalogLoader(fetcher, cacheDirectory);
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
      if (!system && systemId === null) {
        try {
          const text = await catalogs.load(FLYCAST, signal, 4 * 1024 * 1024);
          inferred = text ? parseFlycastCatalog(text) : [];
          const hints = matchLibretro(input, inferred);
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
            ? parseLibretroDat(text).map((record) =>
                arcade
                  ? {
                      ...record,
                      systemId: systemId ?? undefined,
                      source: 'Libretro arcade catalog',
                    }
                  : record,
              )
            : [];
        } catch (error) {
          failures.push(error);
          return [];
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
              if (inferred) return inferred.filter((record) => record.systemId === systemId);
              return text
                ? parseFlycastCatalog(text).filter((record) => record.systemId === systemId)
                : [];
            } catch (error) {
              failures.push(error);
              return [];
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
          return index ? artworkIndex(index) : [];
        } catch (error) {
          failures.push(error);
          return [];
        }
      })();
      const [records, artworks] = await Promise.all([
        Promise.all(tables).then((values) => values.flat()),
        indexed,
      ]);
      const metadata = matchLibretro(lookupInput, records);
      signal?.throwIfAborted();
      // A checksum can establish the public title even when the original file was renamed.
      // Filename-only suggestions stay bounded and region/edition-aware for explicit review.
      const names = [input.name, ...metadata.map((candidate) => candidate.title)];
      const art = artworks
        .map((image, index) => ({
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
        )
        .slice(0, 24)
        .map(
          ({ image, index }): MatchCandidate => ({
            id: `art-${index}`,
            kind: 'artwork',
            title: image.title,
            confidence: 'name',
            url: `https://raw.githubusercontent.com/libretro-thumbnails/${repo}/${image.sha}/${image.path
              .split('/')
              .map((segment) => encodeURIComponent(segment))
              .join('/')}`,
            metadata: {
              source: 'Libretro thumbnails',
              artworkType: image.kind,
              matchedGame: contentStem(input.name),
              availability: 'Listed in public artwork catalog; image checked on preview',
            },
          }),
        );
      const candidates = [...metadata, ...art];
      if (failures.length) throw new PartialMatchingError(candidates);
      return candidates;
    },
  };
}
