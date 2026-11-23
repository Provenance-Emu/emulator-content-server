import { ContentError, type ManifestFile, type SourceFile } from '@ecs/client';
import type { PlayerClient } from './controller.js';
import { type BrowserCore, isDreamcastCore } from './runtime.js';

const LIMIT = 32 * 1024 * 1024;

function firmwarePaths(core: BrowserCore, system: string | null): string[] {
  if (system === 'com.provenance.dreamcast' && isDreamcastCore(core)) return ['dc/dc_boot.bin'];
  if (system === 'com.provenance.psx' && core.id === 'org.libretro.pcsx-rearmed')
    return ['scph5500.bin', 'scph5501.bin', 'scph5502.bin', 'psxonpsp660.bin'];
  if (system === 'com.provenance.fds' && core.id === 'org.libretro.nestopia')
    return ['disksys.rom'];
  if (
    system === 'com.provenance.segacd' &&
    ['genesis-plus-gx', 'genesis-plus-gx-wide', 'picodrive', 'clownmdemu'].some(
      (id) => core.id === `org.libretro.${id}`,
    )
  )
    return ['bios_CD_U.bin', 'bios_CD_E.bin', 'bios_CD_J.bin'];
  if (core.id === 'org.libretro.prboom') return ['prboom.wad'];
  if (core.id === 'org.libretro.gearcoleco') return ['colecovision.rom', 'eos.rom', 'writer.rom'];
  if (core.id === 'org.libretro.o2em') return ['o2rom.bin', 'c52.bin', 'g7400.bin', 'jopac.bin'];
  if (core.id === 'org.libretro.opera')
    return [
      'panafz1.bin',
      'panafz10.bin',
      'panafz10-norsa.bin',
      'panafz10e-anvil.bin',
      'panafz10e-anvil-norsa.bin',
      'goldstar.bin',
      'sanyotry.bin',
      '3do_arcade_saot.bin',
      'panafz1-kanji.bin',
      'panafz10ja-anvil-kanji.bin',
      'panafz1j.bin',
      'panafz1j-norsa.bin',
      'panafz1j-kanji.bin',
    ];
  if (system === 'com.provenance.neogeocd' && core.id === 'org.libretro.neocd')
    return [
      'neocd_f.rom',
      'neocd_sf.rom',
      'front-sp1.bin',
      'neocd_t.rom',
      'neocd_st.rom',
      'top-sp1.bin',
      'neocd_z.rom',
      'neocd_sz.rom',
      'neocd.bin',
      'ng-lo.rom',
      '000-lo.lo',
      'uni-bioscd.rom',
    ].map((name) => `neocd/${name}`);
  return [];
}

export function systemAssetPath(core: BrowserCore, name: string): string {
  const lower = name.toLowerCase();
  const expected = core.systems
    .flatMap((system) => firmwarePaths(core, system))
    .find((path) => path.split('/').at(-1)?.toLowerCase() === lower);
  if (expected) return `/ecs/system/${expected}`;
  const dir = 'profileVersion' in core ? core.systemFilesDirectory : undefined;
  return dir ? `/ecs/system/${dir}/${name}` : `/ecs/system/${name}`;
}

function isFirmware(kind: string): boolean {
  return kind === 'bios' || kind === 'system_file';
}

async function librarySources(
  client: PlayerClient,
  libraryId: string | null,
  signal?: AbortSignal,
): Promise<SourceFile[]> {
  if (!client.browse || !libraryId) return (await client.sources()).items;
  const items: SourceFile[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    try {
      const page = await client.browse(
        { libraryId, category: 'system_files', limit: 100, cursor },
        signal,
      );
      for (const entry of page.items)
        if (entry.entityType === 'source' && entry.source) items.push(entry.source);
      cursor = page.nextCursor ?? undefined;
    } catch (error) {
      if (error instanceof ContentError && (error.status === 403 || error.status === 404)) {
        // The list remains filtered by source grants on old servers and item-only shares.
        return (await client.sources()).items;
      }
      throw error;
    }
    if (cursor && cursors.has(cursor)) throw new Error('System file listing did not advance');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return items;
}

export async function collectFirmware(
  client: PlayerClient,
  core: BrowserCore,
  target: {
    system: string | null;
    libraryId: string | null;
    files: ManifestFile[];
    source?: SourceFile;
    sources?: SourceFile[];
  },
  signal?: AbortSignal,
) {
  const installed = 'profileVersion' in core ? core.assets : [];
  const paths = firmwarePaths(core, target.system).filter(
    (path) =>
      !installed.some(
        (asset) =>
          systemAssetPath(core, asset.name).toLowerCase() === `/ecs/system/${path.toLowerCase()}`,
      ),
  );
  const files: { path: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
  if (!paths.length) return files;
  let sources = target.sources;
  let remaining = LIMIT - installed.reduce((total, asset) => total + asset.sizeBytes, 0);
  for (const path of paths) {
    signal?.throwIfAborted();
    const name = path.split('/').at(-1)?.toLowerCase();
    const fixedSize = name === 'dc_boot.bin' ? 2 * 1024 ** 2 : undefined;
    // An owner often has the same system file in more than one folder. Any copy that fits will
    // do, and the same one is taken every time so a session does not change between starts.
    const pick = <T extends { size: number }>(copies: T[], order: (copy: T) => string) => {
      const fitting = copies.filter((copy) => fixedSize === undefined || copy.size === fixedSize);
      return (fitting.length ? fitting : copies).sort((a, b) =>
        order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0,
      )[0];
    };
    const asset = pick(
      target.files.filter(
        (file) =>
          isFirmware(file.kind) && file.relativePath.split('/').at(-1)?.toLowerCase() === name,
      ),
      (file) => `${file.relativePath}\0${file.id}`,
    );
    let source: SourceFile | undefined;
    if (!asset && (target.libraryId || target.source)) {
      sources ??= await librarySources(client, target.libraryId, signal);
      const candidates = sources.filter(
        (file) =>
          file.availability === 'local' &&
          isFirmware(file.kind) &&
          file.name.toLowerCase() === name &&
          (target.libraryId
            ? file.libraryId === target.libraryId
            : file.rootId === target.source?.rootId),
      );
      const sameRoot = candidates.filter((file) => file.rootId === target.source?.rootId);
      source = pick(
        sameRoot.length ? sameRoot : candidates,
        (file) => `${file.contentPath ?? ''}\0${file.id}`,
      );
    }
    const file = asset ?? source;
    if (!file) {
      if (name === 'prboom.wad')
        throw new Error('Add prboom.wad to this game library and rescan the folder.');
      continue;
    }
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > remaining ||
      (fixedSize !== undefined && file.size !== fixedSize)
    )
      throw new Error(`Invalid firmware size for ${name}.`);
    const collect = asset ? client.collect.bind(client) : client.collectSource.bind(client);
    const { bytes } = await collect(file.id, { maxBytes: file.size, signal });
    if (bytes.byteLength !== file.size)
      throw new Error(`Firmware ${name} changed. Rescan its folder.`);
    remaining -= bytes.byteLength;
    files.push({ path: `/ecs/system/${path}`, bytes });
  }
  return files;
}
