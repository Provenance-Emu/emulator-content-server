import type { Item, ManifestFile, SourceFile } from '@ecs/client';
import { supportsContentName } from './archive.js';
import { type BrowserCore, validateProfile } from './runtime.js';
export type PlayableCores = BrowserCore | readonly BrowserCore[] | null;
function supported(
  cores: PlayableCores,
  system: string | null,
  name: string,
  kind: string,
  size: number,
): BrowserCore | undefined {
  if (!cores || system === null || kind !== 'rom' || size <= 0 || /\.(gdi|ccd|m3u)$/i.test(name))
    return;
  for (const core of Array.isArray(cores) ? cores : [cores as BrowserCore]) {
    try {
      validateProfile(core);
    } catch {
      continue;
    }
    if (
      core.systems.includes(system) &&
      supportsContentName(core, name) &&
      size <= core.maxContentBytes
    )
      return core;
  }
}
function profileQuery(core: BrowserCore): string {
  return 'profileVersion' in core && core.id.includes('.')
    ? `&profile=${encodeURIComponent(core.id)}`
    : '';
}
export function assetPlayHref(cores: PlayableCores, item: Item, file: ManifestFile): string | null {
  const core = supported(cores, item.systemIdentifier, file.relativePath, file.kind, file.size);
  return core
    ? `/play/?item=${encodeURIComponent(item.id)}&asset=${encodeURIComponent(file.id)}${profileQuery(core)}`
    : null;
}
export function sourcePlayHref(cores: PlayableCores, source: SourceFile): string | null {
  const core =
    source.availability === 'local' &&
    !source.groupError &&
    ((source.groupFileCount ?? 1) <= 1 || /\.cue$/i.test(source.name))
      ? supported(cores, source.systemId, source.name, source.kind, source.size)
      : undefined;
  return core ? `/play/?source=${encodeURIComponent(source.id)}${profileQuery(core)}` : null;
}

/** Return links carry collection state without permitting another destination. */
export function playerReturnHref(value: string | null, origin: string): string {
  if (!value?.startsWith('/ui/')) return '/ui/';
  try {
    const destination = new URL(value, origin);
    if (destination.origin !== origin || destination.pathname !== '/ui/') return '/ui/';
    return destination.pathname + destination.search + destination.hash;
  } catch {
    return '/ui/';
  }
}

export function playUnavailableReason(
  cores: PlayableCores,
  system: string | null,
  name: string,
  kind: string,
  size: number,
): string | null {
  if (supported(cores, system, name, kind, size)) return null;
  if (!system) return 'Choose the game’s console before playing it.';
  const installed = (cores ? (Array.isArray(cores) ? cores : [cores as BrowserCore]) : []).filter(
    (core) => {
      try {
        validateProfile(core);
        return core.systems.includes(system);
      } catch {
        return false;
      }
    },
  );
  if (!installed.length)
    return 'No enabled browser emulator supports this console. Install or enable one in Settings → Emulators.';
  if (/\.rar$/i.test(name))
    return 'Extract this archive and rescan the library folder. Browser play supports a single game in a ZIP or 7z, or an uncompressed game file.';
  if (size <= 0)
    return 'This game file is empty. Rescan its library folder after restoring the file.';
  if (installed.every((core) => size > core.maxContentBytes))
    return 'This game exceeds the installed emulators’ supported file size.';
  return 'This file format is unsupported by the enabled emulators for this console. Check the supported formats in Settings → Emulators.';
}
export function sourcePlayUnavailableReason(
  cores: PlayableCores,
  source: SourceFile,
): string | null {
  if (sourcePlayHref(cores, source)) return null;
  if (source.availability !== 'local')
    return 'Bring this library folder online and download the game on the server first.';
  if (source.groupError)
    return 'Fix this disc set’s missing or invalid files, then rescan the library folder.';
  if ((source.groupFileCount ?? 1) > 1 && !/\.cue$/i.test(source.name))
    return 'Open the disc set’s CUE file to play it, or choose a supported single-file disc image.';
  return playUnavailableReason(cores, source.systemId, source.name, source.kind, source.size);
}
