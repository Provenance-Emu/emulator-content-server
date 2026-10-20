import type { Item, ManifestFile, PlayerCoreDescriptor, SourceFile } from '@ecs/client';
import { validateProfile } from './runtime.js';

function supports(
  core: PlayerCoreDescriptor | null,
  system: string | null,
  name: string,
  kind: string,
  size: number,
): boolean {
  if (!core) return false;
  try {
    validateProfile(core);
  } catch {
    return false;
  }
  return (
    kind === 'rom' &&
    system !== null &&
    core.systems.includes(system) &&
    name.toLowerCase().endsWith('.nes') &&
    size > 0 &&
    size <= core.maxContentBytes
  );
}
export function assetPlayHref(
  core: PlayerCoreDescriptor | null,
  item: Item,
  file: ManifestFile,
): string | null {
  if (!supports(core, item.systemIdentifier, file.relativePath, file.kind, file.size)) return null;
  return `/play/?item=${encodeURIComponent(item.id)}&asset=${encodeURIComponent(file.id)}`;
}
export function sourcePlayHref(
  core: PlayerCoreDescriptor | null,
  source: SourceFile,
): string | null {
  if (
    source.availability !== 'local' ||
    !supports(core, source.systemId, source.name, source.kind, source.size)
  )
    return null;
  return `/play/?source=${encodeURIComponent(source.id)}`;
}
