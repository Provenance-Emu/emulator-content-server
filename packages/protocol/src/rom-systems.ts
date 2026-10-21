// System names/extensions from Provenance PVLibrary/Resources/systems.plist.
// Snapshot 44ee92b14399f79d40548bc74186e6782a86762d; metadata only, no emulator implementation or ROM bytes.
import { PROVENANCE_SYSTEMS } from './systems.js';

const definitions = [
  {
    id: 'com.provenance.psp',
    names: ['PlayStation Portable', 'PSP', 'psp'],
    extensions: ['zip', 'pbp', 'iso', 'cso', '7z', 'elf', 'cue'],
  },
  {
    id: 'com.provenance.gamecube',
    names: ['GameCube', 'GC', 'gamecube'],
    extensions: ['zip', 'elf', 'iso', 'gcm', 'dol', 'tgc', 'wbfs', 'ciso', 'gcz', 'wad', 'rvz'],
  },
  {
    id: 'com.provenance.wii',
    names: ['Wii', 'wii'],
    extensions: ['zip', 'elf', 'iso', 'gcm', 'dol', 'tgc', 'wbfs', 'ciso', 'gcz', 'wad', 'rvz'],
  },
  {
    id: 'com.provenance.n64',
    names: ['Nintendo 64', 'N64', 'n64'],
    extensions: ['zip', 'n64', 'z64'],
  },
  {
    id: 'com.provenance.psx',
    names: ['PlayStation', 'PSX', 'psx'],
    extensions: ['zip', 'cue', 'ccd', 'pbp', 'chd', 'm3u', 'toc'],
  },
  {
    id: 'com.provenance.ps2',
    names: ['PlayStation 2', 'PS2', 'ps2'],
    extensions: [
      'zip',
      'cue',
      'ccd',
      'chd',
      'cso',
      'cdi',
      'elf',
      'iso',
      'isz',
      'm3u',
      'gz',
      'nrg',
      'mdf',
      'ciso',
      'ps2',
      'img',
    ],
  },
  {
    id: 'com.provenance.lynx',
    names: ['Atari Lynx', 'LYNX', 'lynx'],
    extensions: ['lnx', 'o', 'zip'],
  },
  {
    id: 'com.provenance.ngp',
    names: ['Neo Geo Pocket', 'NGP', 'ngp'],
    extensions: ['ngp', 'zip'],
  },
  {
    id: 'com.provenance.mame',
    names: ['MAME', 'Arcade', 'mame'],
    extensions: ['zip', 'cmd', 'chd', '7z'],
  },
  {
    id: 'com.provenance.cps1',
    names: ['CPS-1', 'CPS1', 'cps1'],
    extensions: ['zip'],
  },
  {
    id: 'com.provenance.cps2',
    names: ['CPS-2', 'CPS2', 'cps2'],
    extensions: ['zip'],
  },
  {
    id: 'com.provenance.cps3',
    names: ['CPS-3', 'CPS3', 'cps3'],
    extensions: ['zip'],
  },
  {
    id: 'com.provenance.appleII',
    names: ['Apple II', 'II/IIe/IIgs', 'appleII'],
    extensions: ['zip', 'dsk', 'cmd'],
  },
  {
    id: 'com.provenance.neogeo',
    names: ['Neo Geo', 'NeoGeo', 'neogeo'],
    extensions: ['ng', 'zip', 'cmd', 'neo'],
  },
  {
    id: 'com.provenance.neogeocd',
    names: ['Neo Geo CD', 'NeoGeoCD', 'neogeocd'],
    extensions: ['cue', 'chd', 'm3u', 'iso'],
  },
  {
    id: 'com.provenance.ngpc',
    names: ['Neo Geo Pocket Color', 'NeoGeoPocketColor', 'ngpc'],
    extensions: ['zip', 'ngc', 'ngpc', 'npc'],
  },
  {
    id: 'com.provenance.vb',
    names: ['Virtual Boy', 'vb'],
    extensions: ['zip', 'vb', 'vboy', 'bin'],
  },
  {
    id: 'com.provenance.ws',
    names: ['WonderSwan', 'WS', 'ws'],
    extensions: ['ws'],
  },
  {
    id: 'com.provenance.wsc',
    names: ['WonderSwan', 'WSC', 'wsc'],
    extensions: ['wsc'],
  },
  {
    id: 'com.provenance.pce',
    names: ['TurboGrafx-16', 'TG16', 'pce'],
    extensions: ['zip', 'pce'],
  },
  {
    id: 'com.provenance.sgfx',
    names: ['SuperGrafx', 'SGRFX', 'sgfx'],
    extensions: ['zip', 'sgx'],
  },
  {
    id: 'com.provenance.pcecd',
    names: ['TurboGrafx-CD', 'TG16CD', 'pcecd'],
    extensions: ['zip', 'cue', 'ccd', 'chd', 'toc', 'm3u'],
  },
  {
    id: 'com.provenance.pcfx',
    names: ['PCFX', 'pcfx'],
    extensions: ['zip', 'cue', 'ccd', 'chd'],
  },
  {
    id: 'com.provenance.segacd',
    names: ['Sega CD', 'SCD', 'segacd'],
    extensions: ['chd', 'zip', 'cue', 'iso'],
  },
  {
    id: 'com.provenance.genesis',
    names: ['Genesis', 'SG', 'genesis'],
    extensions: [
      'smd',
      'md',
      'mdx',
      'gen',
      'bin',
      'sms',
      'bms',
      'gg',
      '68k',
      'sgd',
      'chd',
      'm3u',
      'zip',
    ],
  },
  {
    id: 'com.provenance.saturn',
    names: ['Saturn', 'saturn'],
    extensions: ['zip', 'iso', 'mds', 'cue', 'ccd', 'chd', 'toc', 'm3u'],
  },
  {
    id: 'com.provenance.gamegear',
    names: ['Game Gear', 'gamegear'],
    extensions: ['zip', 'gg'],
  },
  {
    id: 'com.provenance.dreamcast',
    names: ['Dreamcast', 'DC', 'dreamcast'],
    extensions: ['zip', 'chd', 'gdi', 'cdi', 'cue', 'iso', 'elf', '7z'],
  },
  {
    id: 'com.provenance.naomi',
    names: ['NAOMI', 'naomi'],
    extensions: ['zip', 'chd', 'dat', 'lst', 'bin', '7z'],
  },
  {
    id: 'com.provenance.atomiswave',
    names: ['Atomiswave', 'AW', 'atomiswave'],
    extensions: ['zip', 'chd', 'dat', 'lst', 'bin', '7z'],
  },
  {
    id: 'com.provenance.naomi2',
    names: ['NAOMI 2', 'NAOMI2', 'naomi2'],
    extensions: ['zip', 'chd', 'dat', 'lst', 'bin', '7z'],
  },
  {
    id: 'com.provenance.mastersystem',
    names: ['Master System', 'SMS', 'mastersystem'],
    extensions: ['sms'],
  },
  {
    id: 'com.provenance.snes',
    names: ['Super Nintendo', 'SNES', 'snes'],
    extensions: ['smc', 'snes', 'fig', 'sfc', 'zip'],
  },
  {
    id: 'com.provenance.gba',
    names: ['Game Boy Advance', 'GBA', 'gba'],
    extensions: ['gba', 'agb', 'bin', 'zip'],
  },
  {
    id: 'com.provenance.ds',
    names: ['DS', 'ds'],
    extensions: ['zip', 'nds', 'ids'],
  },
  {
    id: 'com.provenance.3ds',
    names: ['3DS', '3ds'],
    extensions: ['zip', '3ds', '3dsx', 'elf', 'axf', 'cci', 'cxi', 'cia', 'app'],
  },
  {
    id: 'com.provenance.gb',
    names: ['Game Boy', 'GB', 'gb'],
    extensions: ['gb', 'zip'],
  },
  {
    id: 'com.provenance.gbc',
    names: ['Game Boy Color', 'GBC', 'gbc'],
    extensions: ['gbc', 'sgb', 'zip'],
  },
  {
    id: 'com.provenance.nes',
    names: ['Nintendo', 'NES', 'nes'],
    extensions: ['nes', 'unf', 'unif', 'zip'],
  },
  {
    id: 'com.provenance.music',
    names: ['Game Music', 'GME', 'music'],
    extensions: ['ay', 'gbs', 'gym', 'hes', 'kss', 'nsf', 'nsfe', 'sap', 'spc', 'vgm', 'vgz'],
  },
  {
    id: 'com.provenance.fds',
    names: ['Famicom Disk System', 'FDS', 'fds'],
    extensions: ['fds'],
  },
  {
    id: 'com.provenance.sg1000',
    names: ['SG-1000', 'sg1000'],
    extensions: ['sg'],
  },
  {
    id: 'com.provenance.2600',
    names: ['Atari 2600', '2600'],
    extensions: ['a26', 'bin', 'zip'],
  },
  {
    id: 'com.provenance.7800',
    names: ['Atari 7800', '7800'],
    extensions: ['a78', 'bin', 'cdf', 'zip'],
  },
  {
    id: 'com.provenance.jaguar',
    names: ['Atari Jaguar', 'Jaguar', 'jaguar'],
    extensions: ['j64', 'jag', 'rom', 'abs', 'cof', 'bin', 'prg', 'zip'],
  },
  {
    id: 'com.provenance.jaguarcd',
    names: ['Atari Jaguar CD', 'Jaguar CD', 'jaguarcd'],
    extensions: ['cue', 'cdi'],
  },
  {
    id: 'com.provenance.32X',
    names: ['32X'],
    extensions: ['32x'],
  },
  {
    id: 'com.provenance.5200',
    names: ['Atari 5200', '5200'],
    extensions: ['xfd', 'atr', 'atx', 'cdm', 'cas', 'bin', 'a52', 'xex', 'zip'],
  },
  {
    id: 'com.provenance.atari8bit',
    names: ['Atari 8bit Computer', '8Bit', 'atari8bit'],
    extensions: ['xfd', 'atr', 'atx', 'cdm', 'bas', 'cas', 'bin', 'xex', 'a52', 'zip'],
  },
  {
    id: 'com.provenance.atarist',
    names: ['Atari ST', 'ST', 'atarist'],
    extensions: ['st', 'msa', 'mas', 'zip', 'stx', 'dim', 'ipf'],
  },
  {
    id: 'com.provenance.dos',
    names: ['IBM PC DOS', 'DOS', 'dos'],
    extensions: [
      'exe',
      'com',
      'bat',
      'conf',
      'cfg',
      'img',
      'zip',
      'dosz',
      'iso',
      'cue',
      'ins',
      'ima',
      'vhd',
      'jrc',
      'tc',
      'm3u',
      'm3u8',
    ],
  },
  {
    id: 'com.provenance.c64',
    names: ['Commodore 64', 'C64', 'c64'],
    extensions: [
      'd64',
      'd6z',
      'd71',
      'd7z',
      'd80',
      'd81',
      'd82',
      'd8z',
      'g64',
      'g6z',
      'g41',
      'g4z',
      'x64',
      'x6z',
      'nib',
      'nbz',
      'd2m',
      'd4m',
      'm3u',
      'cmd',
      '20',
      '40',
      '60',
      'a0',
      'b0',
      'rom',
    ],
  },
  {
    id: 'com.provenance.zxspectrum',
    names: ['ZX Spectrum', 'Z80', 'zxspectrum'],
    extensions: ['z80', 'tzx'],
  },
  {
    id: 'com.provenance.msx',
    names: ['MSX', 'msx'],
    extensions: ['cas', 'tsx', 'wav', 'dsk', 'msx', 'mx2', 'mx1', 'rom', 'm3u'],
  },
  {
    id: 'com.provenance.msx2',
    names: ['MSX2', 'msx2'],
    extensions: ['cas', 'tsx', 'wav', 'dsk', 'msx', 'mx2', 'mx1', 'rom', 'm3u'],
  },
  {
    id: 'com.provenance.macintosh',
    names: ['Macintosh', 'Mac', 'macintosh'],
    extensions: ['hdi', 'img', 'dsk', 'zip', 'hvf', 'cmd'],
  },
  {
    id: 'com.provenance.pokemonmini',
    names: ['Pokémon mini', 'Pm', 'pokemonmini'],
    extensions: ['min'],
  },
  {
    id: 'com.provenance.odyssey2',
    names: ['Magnavox Odyssey2', 'Odyssey2', 'odyssey2'],
    extensions: ['ody', 'od2'],
  },
  {
    id: 'com.provenance.vectrex',
    names: ['Smith Engineering Vectrex', 'Vectrex', 'vectrex'],
    extensions: ['vec'],
  },
  {
    id: 'com.provenance.ep128',
    names: ['Enterprise 128', 'ep128'],
    extensions: ['img', 'dsk', 'tap', 'dtf', '128', 'trn', 'bas', 'cdt'],
  },
  {
    id: 'com.provenance.colecovision',
    names: ['CBS ColecoVision', 'ColecoVision', 'colecovision'],
    extensions: ['col', 'cv', 'rom'],
  },
  {
    id: 'com.provenance.intellivision',
    names: ['Mattel Intellivision', 'Intellivision', 'intellivision'],
    extensions: ['int', 'rom', 'bin'],
  },
  {
    id: 'com.provenance.supervision',
    names: ['Supervision', 'supervision'],
    extensions: ['bin', 'sv'],
  },
  {
    id: 'com.provenance.3DO',
    names: ['3DO'],
    extensions: ['zip', 'cue', 'iso', 'm3u', 'chd'],
  },
  {
    id: 'com.provenance.pc98',
    names: ['PC98', 'pc98'],
    extensions: [
      'd98',
      'zip',
      'rar',
      'lzh',
      '98d',
      'fdi',
      'fdd',
      '2hd',
      'tfd',
      'd88',
      'hdm',
      '88d',
      'xdf',
      'dup',
      'cmd',
      'hdi',
      'thd',
      'nhd',
      'hdd',
      'hdn',
    ],
  },
  {
    id: 'com.provenance.retroarch',
    names: ['RetroArch', 'retroarch'],
    extensions: ['opt', 'cfg'],
  },
  {
    id: 'com.provenance.cdi',
    names: ['CD-i', 'cdi'],
    extensions: ['chd', 'iso', 'cue'],
  },
  {
    id: 'com.provenance.palmos',
    names: ['PalmOS', 'palmos'],
    extensions: ['prc', 'pqa', 'pdb', 'zip', 'img'],
  },
  {
    id: 'com.provenance.wolf3d',
    names: ['Wolfenstein 3D', 'Wolf3D', 'wolf3d'],
    extensions: ['wl6', 'n3d', 'sod', 'sdm', 'wl1', 'pk3'],
  },
  {
    id: 'com.provenance.doom',
    names: ['Doom', 'doom'],
    extensions: ['wad', 'iwad', 'pwad'],
  },
  {
    id: 'com.provenance.quake',
    names: ['Quake', 'quake'],
    extensions: ['pak'],
  },
  {
    id: 'com.provenance.quake2',
    names: ['Quake II', 'QuakeII', 'quake2'],
    extensions: ['pak'],
  },
  {
    id: 'com.provenance.tic80',
    names: ['TIC-80', 'tic80'],
    extensions: ['tic', 'zip'],
  },
] as const;
const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const containers = new Set([
  'zip',
  '7z',
  'cue',
  'bin',
  'iso',
  'chd',
  'm3u',
  'ccd',
  'toc',
  'pbp',
  'cso',
  'cdi',
]);
export interface RomSystemDetection {
  systemId: string | null;
  basis: 'extension' | 'folder' | 'unknown';
  candidates: string[];
}
/** Names are hints, never a claim that a shared disc container identifies a console. */
export function detectRomSystem(path: string): RomSystemDetection {
  const parts = path.replaceAll('\\', '/').split('/');
  const extension = parts.at(-1)?.split('.').at(-1)?.toLowerCase() ?? '';
  const known = new Set(PROVENANCE_SYSTEMS.map((s) => s.identifier));
  const candidates: string[] = [
    ...new Set(
      definitions
        .filter((s) => known.has(s.id) && (s.extensions as readonly string[]).includes(extension))
        .map((s) => s.id),
    ),
  ];
  let hinted: string | null = null;
  for (const folder of parts.slice(0, -1).reverse()) {
    const name = ` ${normalize(folder)} `;
    const hints = definitions
      .flatMap((s) =>
        s.names.filter(Boolean).map((alias) => ({ id: s.id, alias: normalize(alias) })),
      )
      .filter(
        (s) =>
          known.has(s.id) &&
          s.alias.length > 1 &&
          !containers.has(s.alias) &&
          name.includes(` ${s.alias} `),
      )
      .sort((a, b) => b.alias.length - a.alias.length);
    if (hints[0]) {
      hinted = hints[0].id;
      break;
    }
  }
  if (
    hinted &&
    (containers.has(extension) || candidates.length !== 1 || candidates.includes(hinted))
  )
    return { systemId: hinted, basis: 'folder', candidates: [...new Set([hinted, ...candidates])] };
  // Genesis cores also accept Game Gear bytes; .gg still names the Game Gear platform.
  if (extension === 'gg')
    return { systemId: 'com.provenance.gamegear', basis: 'extension', candidates };
  if (candidates.length === 1 && !containers.has(extension))
    return { systemId: candidates[0] ?? null, basis: 'extension', candidates };
  return { systemId: null, basis: 'unknown', candidates };
}
export function isRomExtension(path: string): boolean {
  const extension = path.toLowerCase().split('.').at(-1) ?? '';
  return (
    containers.has(extension) ||
    definitions.some((s) => (s.extensions as readonly string[]).includes(extension))
  );
}
