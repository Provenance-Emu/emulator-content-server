import type { PlayerCatalogEntry, PlayerManagement } from '@ecs/client';

// Ordered preferences for the catalog's ordinary single-player configurations.
// Each core is included only when it adds coverage beyond enabled installations.
const preferredCoreIds = [
  'org.libretro.fceumm',
  'org.libretro.virtualjaguar',
  'org.libretro.nestopia',
  'org.libretro.snes9x',
  'org.libretro.mgba',
  'org.libretro.gambatte',
  'org.libretro.genesis-plus-gx',
  'org.libretro.picodrive',
  'org.libretro.pcsx-rearmed',
  'org.libretro.beetle-pce-fast',
  'org.libretro.geargrafx',
  'org.libretro.beetle-lynx',
  'org.libretro.beetle-ngp',
  'org.libretro.beetle-wswan',
  'org.libretro.beetle-vb',
  'org.libretro.fbneo',
  'org.libretro.stella2014',
  'org.libretro.prosystem',
  'org.libretro.atari800',
  'org.libretro.freeintv',
  'org.libretro.gearcoleco',
  'org.libretro.pokemini',
  'org.libretro.potator',
  'org.libretro.sameduck',
  'org.libretro.mednafen-pcfx',
  'org.libretro.mupen64plus-next',
  'org.libretro.parallel-dc',
  'org.libretro.neocd',
  'org.libretro.o2em',
  'org.libretro.opera',
  'org.libretro.vecx',
  'org.libretro.vice-x64sc',
  'org.libretro.quicknes',
  'org.libretro.snes9x2010',
  'org.libretro.vba-next',
  'org.libretro.gearboy',
  'org.libretro.gearsystem',
  'org.libretro.handy',
  'org.libretro.mame2003-plus',
] as const;

export function recommendedEmulators(listing: PlayerManagement): PlayerCatalogEntry[] {
  const installed = new Set(listing.items.map((item) => item.profile.id));
  const covered = new Set(
    listing.items.filter((item) => item.enabled).flatMap((item) => item.profile.systems),
  );
  const available = new Map(
    listing.available
      .filter((entry) => entry.available && !installed.has(entry.id))
      .map((entry) => [entry.id, entry]),
  );
  const recommended: PlayerCatalogEntry[] = [];
  for (const id of preferredCoreIds) {
    const entry = available.get(id);
    if (!entry || entry.systems.every((system) => covered.has(system))) continue;
    recommended.push(entry);
    entry.systems.forEach((system) => {
      covered.add(system);
    });
  }
  return recommended;
}
