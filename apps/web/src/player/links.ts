import type { Item, ManifestFile, SourceFile } from '@ecs/client';
import { type BrowserCore, contentExtensions, validateProfile } from './runtime.js';
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
      contentExtensions(core).some((extension) => name.toLowerCase().endsWith(`.${extension}`)) &&
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
