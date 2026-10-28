import { posix } from 'node:path';

export const companionDirectory = (path: string): string => posix.dirname(path);
export const companionExtension = (name: string): string =>
  posix.extname(name).slice(1).toLowerCase();
export const gameStem = (name: string): string =>
  name
    .replace(/\.[^.]+$/, '')
    .normalize('NFC')
    .toLowerCase();
export function companionStem(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/(?:[ ._-](?:cover|boxart|front))$/i, '')
    .replace(/\s+\((?:Game Genie|Action Replay|Pro Action Replay|GameShark|CodeBreaker)\)$/i, '')
    .normalize('NFC')
    .toLowerCase();
}

/** Equality seeks with a per-directory limit prevent ORDER BY from choosing a whole-root path scan. */
export function companionSelection(rootId: string, relativePath: string, checksum: boolean) {
  const directory = companionDirectory(relativePath);
  const directories = [
    directory,
    ...['artwork', 'boxart', 'covers', 'patches', 'metadata', 'cheats'].map((name) =>
      posix.join(directory, name),
    ),
  ];
  const values: string[] = [];
  const branches: string[] = [];
  for (const parent of directories) {
    values.push(rootId, parent, gameStem(posix.basename(relativePath)), relativePath);
    branches.push(`SELECT * FROM (SELECT id,relative_path FROM source_files INDEXED BY source_files_match_stem
      WHERE root_id=? AND missing_at IS NULL AND match_parent=? AND match_stem=? AND relative_path<>?
      ORDER BY relative_path LIMIT 100)`);
    if (checksum)
      for (const extension of ['bps', 'ups']) {
        values.push(rootId, parent, extension, relativePath);
        branches.push(`SELECT * FROM (SELECT id,relative_path FROM source_files INDEXED BY source_files_match_extension
        WHERE root_id=? AND missing_at IS NULL AND match_parent=? AND match_extension=? AND relative_path<>?
        ORDER BY relative_path LIMIT 100)`);
      }
  }
  return { sql: branches.join(' UNION ') + ' ORDER BY relative_path LIMIT 100', values };
}
