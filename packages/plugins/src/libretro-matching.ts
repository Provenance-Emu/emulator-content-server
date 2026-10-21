import {
  type DatRecord,
  type MatchingProvider,
  matchLibretro,
  parseLibretroDat,
} from './matching.js';

const SYSTEMS: Record<string, { platform: string; collection: string }> = {
  'com.provenance.jaguar': { platform: 'Atari - Jaguar', collection: 'no-intro' },
  'com.provenance.jaguarcd': { platform: 'Atari - Jaguar CD', collection: 'redump' },
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
};

/** Only public catalogs are fetched. No ROM bytes, path or credentials are sent to Libretro. */
export function createLibretroProvider(fetcher: typeof fetch = fetch): MatchingProvider {
  const cache = new Map<string, { at: number; records: DatRecord[] }>();
  return {
    id: 'org.ecs.libretro',
    name: 'Libretro database and thumbnails',
    capabilities: ['metadata', 'artwork'],
    network: true,
    async search(input, signal) {
      const system = input.systemId ? SYSTEMS[input.systemId] : undefined;
      if (!system) return [];
      const { platform, collection } = system;
      let records = cache.get(platform)?.records;
      if (!records || Date.now() - (cache.get(platform)?.at ?? 0) > 6 * 60 * 60 * 1000) {
        const url = `https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/${collection}/${encodeURIComponent(platform)}.dat`;
        const response = await fetcher(url, { redirect: 'error', ...(signal ? { signal } : {}) });
        if (response.status === 404) return [];
        if (!response.ok || !response.body) throw new Error('Catalog unavailable');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const read = await reader.read();
            if (read.done) break;
            size += read.value.byteLength;
            if (size > 16 * 1024 * 1024) throw new Error('Catalog too large');
            chunks.push(read.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        records = parseLibretroDat(Buffer.concat(chunks).toString('utf8'));
        cache.set(platform, { at: Date.now(), records });
      }
      const metadata = matchLibretro(input, records);
      return metadata.flatMap((candidate) => {
        const image = candidate.title.replace(/[&*/:`<>?\\|]/g, '_');
        const url = `https://raw.githubusercontent.com/libretro-thumbnails/${platform.replaceAll(' ', '_')}/master/Named_Boxarts/${encodeURIComponent(image)}.png`;
        return [
          candidate,
          {
            ...candidate,
            id: `${candidate.id}-art`,
            kind: 'artwork' as const,
            url,
            metadata: {
              source: 'Libretro thumbnails',
              availability: 'Not checked; may be unavailable',
            },
          },
        ];
      });
    },
  };
}
