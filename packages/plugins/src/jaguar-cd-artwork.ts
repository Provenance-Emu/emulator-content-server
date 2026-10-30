/** Public Virtual Jaguar mirror; publisher scans retain upstream third-party rights. */
export const JAGUAR_CD_ARTWORK = {
  repository: 'libretro/virtualjaguar-libretro',
  revision: 'ffea7893a59dd9b9e6f9b85c51627810338b0778',
  prefix: 'site/thumbnails/Atari - Jaguar CD/',
  source: 'Virtual Jaguar thumbnails · TheGamesDB fronts / emulator captures',
  notice:
    'Third-party publisher artwork; source mapping and scan caveats in Virtual Jaguar SOURCES.tsv and README.md',
};

// These release names are explicit mappings between the full Redump AJCD DAT and
// the mirror's older Libretro DAT. Do not strip arbitrary release/edition tags.
const aliases: Record<string, string[]> = {
  "Alice's Mom's Rescue! (Europe) (En,Fr,De,Es,It)": [
    "Alice's Mom's Rescue! (Europe) (En,Fr,De,Es,It) (Unl)",
  ],
  'Frog Feast (USA)': ['Frog Feast (USA) (Unl)'],
  'Philia - The Sequel to Elansar (Europe) (En,Fr)': [
    'Philia - The Sequel to Elansar (Europe) (En,Fr) (Unl)',
  ],
  "Robinson's Requiem (USA)": ["Robinson's Requiem (USA) (Unl)"],
  'Blue Lightning (USA) (En,Fr,De)': [
    'Blue Lightning (USA) (En,Fr,De) (Alt 1)',
    'Blue Lightning (USA) (En,Fr,De) (Alt 2)',
  ],
  'Vid Grid (USA)': ['Vid Grid (USA) (Alt)'],
  'Beebris (Australia) (Disc 1)': ['Beebris (Australia) (Disc 1) (Unl)'],
  'Ocean Depths (Germany)': ['Ocean Depths (Germany) (Unl)'],
  'Simone (USA)': ['Simone (USA) (Unl)'],
};
export function jaguarCdArtworkAliases(title: string): string[] {
  return aliases[title] ?? [];
}
/** The mirror explicitly says these scans were not checked against the named release. */
export function jaguarCdArtworkReview(title: string): string | undefined {
  if (title === 'Blue Lightning (USA)' || title === 'Blue Lightning (USA) (En,Fr,De)')
    return 'The source has one generic cover; its region/language variant was not verified.';
  if (
    [
      'Battle Morph (USA) (Songbird)',
      'Iron Soldier 2 (USA) (Songbird)',
      'World Tour Racing (USA) (Songbird)',
    ].includes(title)
  )
    return 'The source uses the original title cover; Songbird reissue artwork was not verified.';
  return undefined;
}

/** Shared HTTP/worker download policy; the fallback never grants access to arbitrary GitHub files. */
export function isBuiltinArtworkUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (
      url.origin !== 'https://raw.githubusercontent.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    if (url.pathname.startsWith('/libretro-thumbnails/')) return true;
    const prefix = `/${JAGUAR_CD_ARTWORK.repository}/${JAGUAR_CD_ARTWORK.revision}/${JAGUAR_CD_ARTWORK.prefix.split('/').map(encodeURIComponent).join('/')}`;
    if (!url.pathname.startsWith(prefix)) return false;
    const relative = url.pathname.slice(prefix.length);
    const match = /^Named_(?:Boxarts|Titles|Snaps)\/([^/]+\.png)$/.exec(relative);
    return !!match?.[1] && !/[/\\\0]/.test(decodeURIComponent(match[1]));
  } catch {
    return false;
  }
}
