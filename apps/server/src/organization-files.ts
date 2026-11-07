import { posix } from 'node:path';
import { DomainError, type SourceFileRecord } from '@ecs/domain';
import { groupDiscs } from '@ecs/storage';

const DESCRIPTOR = /\.(cue|gdi|ccd|m3u|mds|toc)$/i;
const SIDECAR = /\.(sbi|sub|json|xml|nfo|png|jpe?g|webp)$/i;
const DISC_NUMBER =
  /(?:\s*\((?:disc|disk|cd)\s*\d+(?:\s*of\s*\d+)?\)|[ ._-]+(?:disc|disk|cd)[ ._-]*\d+(?:[ ._-]*of[ ._-]*\d+)?)/i;
const stem = (path: string) => path.slice(0, -posix.extname(path).length).toLowerCase();

function game(file: SourceFileRecord): boolean {
  return file.kind === 'rom' || (file.kind === 'system_file' && DESCRIPTOR.test(file.relativePath));
}

function discFamily(file: SourceFileRecord): string | null {
  const name = stem(posix.basename(file.relativePath));
  if (!game(file) || !DISC_NUMBER.test(name)) return null;
  return posix.join(posix.dirname(file.relativePath).toLowerCase(), name.replace(DISC_NUMBER, ''));
}

/** Follow both directions so organizing a disc or a shared track retains every referring set. */
export function organizationFiles(source: SourceFileRecord, indexed: SourceFileRecord[]) {
  const byPath = new Map(indexed.map((file) => [file.relativePath, file]));
  const paths = new Set([source.relativePath]);
  let changed = true;
  while (changed) {
    const before = paths.size;
    const selected = indexed.filter((file) => paths.has(file.relativePath));
    const stems = new Set(selected.map((file) => stem(file.relativePath)));
    const families = new Set(selected.map(discFamily).filter((value) => value !== null));
    for (const file of indexed) {
      const members = file.groupMembers ?? [];
      const family = discFamily(file);
      if (
        paths.has(file.relativePath) ||
        members.some((path) => paths.has(path)) ||
        ((SIDECAR.test(file.displayName) || DESCRIPTOR.test(file.displayName)) &&
          stems.has(stem(file.relativePath))) ||
        (family !== null && families.has(family))
      ) {
        paths.add(file.relativePath);
        for (const path of members) paths.add(path);
        if (file.groupAnchor) paths.add(file.groupAnchor);
      }
    }
    if (paths.size > 512)
      throw new DomainError(
        'organization-unsupported',
        409,
        'A game set can contain up to 512 files',
      );
    changed = paths.size !== before;
  }
  const files = [...paths].map((path) => {
    const file = byPath.get(path);
    if (!file || file.groupError || file.availability !== 'local')
      throw new DomainError(
        'organization-conflict',
        409,
        'The game set is incomplete or unavailable. Rescan its folder.',
      );
    return file;
  });
  if (!files.some(game))
    throw new DomainError(
      'organization-unsupported',
      409,
      'Choose a ROM, archive, or disc game to organize',
    );
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function validateOrganizationGroups(
  root: string,
  files: SourceFileRecord[],
  indexed: SourceFileRecord[],
) {
  if (!files.some((file) => DESCRIPTOR.test(file.relativePath))) return;
  const current = indexed.map((file) => ({ ...file }));
  await groupDiscs(root, current);
  for (const file of files) {
    const fresh = current.find((item) => item.id === file.id);
    if (
      !fresh ||
      fresh.groupError ||
      JSON.stringify([...(fresh.groupMembers ?? [])].sort()) !==
        JSON.stringify([...(file.groupMembers ?? [])].sort())
    )
      throw new DomainError(
        'organization-conflict',
        409,
        'Disc references changed. Rescan the folder before organizing.',
      );
  }
}

/** Preserve relative descriptor references and original member filenames. */
export function organizationPaths(
  source: SourceFileRecord,
  files: SourceFileRecord[],
  destination: (file: SourceFileRecord) => string,
) {
  if (files.length === 1) return new Map([[source.id, destination(source)]]);
  const anchor = [...files].sort(
    (a, b) => (b.groupMembers?.length ?? 0) - (a.groupMembers?.length ?? 0),
  )[0];
  if (!anchor) throw new Error('Empty organization group');
  let base = posix.dirname(anchor.relativePath);
  for (const file of files)
    while (base !== '.' && !file.relativePath.startsWith(`${base}/`)) base = posix.dirname(base);
  const title =
    source.title ??
    anchor.title ??
    posix
      .basename(anchor.displayName, posix.extname(anchor.displayName))
      .replace(DISC_NUMBER, '')
      .trim();
  const folder = posix.dirname(
    destination({ ...anchor, title, systemId: source.systemId ?? anchor.systemId }),
  );
  return new Map(
    files.map((file) => [file.id, posix.join(folder, posix.relative(base, file.relativePath))]),
  );
}
