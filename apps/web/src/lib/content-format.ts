import type { LibraryBrowseEntry, ManifestFile, SystemSummary } from '@ecs/client';
export const CATEGORY_LABELS = {
  games: 'Games',
  saves: 'Saves',
  media: 'Media',
  system_files: 'System files',
};
export const KIND_ORDER = [
  'rom',
  'battery_save',
  'save_state',
  'screenshot',
  'artwork',
  'bios',
  'system_file',
] as const;
const KIND_LABELS: Record<string, string> = {
  rom: 'ROM',
  battery_save: 'Battery save',
  save_state: 'Save state',
  screenshot: 'Screenshot',
  artwork: 'Artwork',
  bios: 'BIOS',
  system_file: 'System file',
};
const AVAILABILITY_LABELS: Record<string, string> = {
  local: 'On this machine',
  evicted: 'Not downloaded',
  offline: 'Disk offline',
};
export function entryKey(entry: LibraryBrowseEntry): string {
  return `${entry.entityType}:${entry.id}`;
}
export function kindLabel(kind: string): string {
  return Object.hasOwn(KIND_LABELS, kind) ? (KIND_LABELS[kind] ?? kind) : kind;
}
export function systemLabel(id: string | null, systems: SystemSummary[] = []): string {
  if (!id || id === 'unknown') return 'Unknown system';
  return (
    systems.find((system) => system.identifier === id)?.name ??
    (id.startsWith('com.provenance.') ? id.slice('com.provenance.'.length) : id)
  );
}
export function availabilityLabel(availability: string): string {
  return Object.hasOwn(AVAILABILITY_LABELS, availability)
    ? (AVAILABILITY_LABELS[availability] ?? availability)
    : availability;
}
export interface SaveGroup {
  path: string;
  live: ManifestFile | null;
  copies: ManifestFile[];
}
/** Group by kind as well as path: a battery and state file never replace each other. */
export function saveGroups(files: ManifestFile[]): SaveGroup[] {
  const groups = new Map<string, SaveGroup>();
  for (const file of files) {
    if (file.kind !== 'battery_save' && file.kind !== 'save_state') continue;
    const path = file.conflictOf
      ? file.relativePath.replace(/\.conflict-[0-9a-f]{8}$/, '')
      : file.relativePath;
    const key = `${file.kind}:${path}`;
    const group = groups.get(key) ?? { path, live: null, copies: [] };
    if (file.conflictOf) group.copies.push(file);
    else if (!group.live) group.live = file;
    else group.copies.push(file);
    groups.set(key, group);
  }
  return [...groups.values()];
}
