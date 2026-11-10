import { posix } from 'node:path';
import type { ScannedFile } from './scan.js';

const systems = new Set(['com.provenance.naomi', 'com.provenance.naomi2']);
const isArcade = (file: ScannedFile) => file.kind === 'rom' && systems.has(file.systemId ?? '');

/** Flycast looks beside cart.zip for cart/<gdrom>.chd. These are path hints only. */
export function arcadeGroupEdges(
  files: ScannedFile[],
  previous: ReadonlyMap<string, readonly string[]>,
): Map<string, string[]> {
  const knownGroups = new Map(previous);
  for (const members of previous.values()) {
    const primary = members[0];
    if (primary && /\.zip$/i.test(primary)) knownGroups.set(primary, members);
  }
  const previousByCase = new Map(
    [...knownGroups].map(([path, members]) => [path.toLowerCase(), members]),
  );
  const archives = new Map<string, ScannedFile[]>();
  const discs = new Map<string, ScannedFile[]>();
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  for (const file of files) {
    if (!isArcade(file)) continue;
    const path = file.relativePath;
    if (/\.zip$/i.test(path)) {
      const stem = path.slice(0, -4).toLowerCase();
      const matches = archives.get(stem);
      if (matches) matches.push(file);
      else archives.set(stem, [file]);
    } else if (/\.chd$/i.test(path)) {
      const directory = posix.dirname(path).toLowerCase();
      const matches = discs.get(directory);
      if (matches) matches.push(file);
      else discs.set(directory, [file]);
    }
  }
  const edges = new Map<string, string[]>();
  for (const [stem, primaries] of archives) {
    const children = discs.get(stem) ?? [];
    if (primaries.length > 1 && children.length) {
      for (const file of [...primaries, ...children])
        file.groupError = 'Arcade ZIP primary has ambiguous filename casing.';
      continue;
    }
    for (const primary of primaries) {
      const known =
        knownGroups.get(primary.relativePath) ??
        previousByCase.get(primary.relativePath.toLowerCase()) ??
        [];
      const expected = known.filter(
        (path) => /\.chd$/i.test(path) && posix.dirname(path).toLowerCase() === stem,
      );
      const candidates = children.filter((child) => child.systemId === primary.systemId);
      const byFoldedPath = new Map<string, string>();
      let ambiguous = false;
      for (const child of candidates) {
        const key = child.relativePath.toLowerCase();
        if (byFoldedPath.has(key)) ambiguous = true;
        byFoldedPath.set(key, child.relativePath);
      }
      const paths = [
        ...new Set([
          ...candidates.map((child) => child.relativePath),
          ...expected.map((path) => byFoldedPath.get(path.toLowerCase()) ?? path),
        ]),
      ].sort();
      if (!paths.length) continue;
      primary.groupMembers = [primary.relativePath, ...paths.slice(0, 511)];
      edges.set(primary.relativePath, paths);
      for (const child of candidates) child.groupAnchor = primary.relativePath;
      if (paths.length > 511) primary.groupError = 'Disc group has too many members.';
      else if (ambiguous) primary.groupError = 'Arcade GD-ROM has ambiguous filename casing.';
      else if (paths.some((path) => !byPath.has(path)))
        primary.groupError = 'A required arcade GD-ROM is missing. Reconnect it and rescan.';
      else if (
        paths.some((path) => {
          const member = byPath.get(path);
          return !member || !isArcade(member) || member.systemId !== primary.systemId;
        })
      )
        primary.groupError = 'An arcade GD-ROM has incompatible file or system metadata.';
      else if (
        primary.availability !== 'local' ||
        paths.some((path) => byPath.get(path)?.availability !== 'local')
      )
        primary.groupError = 'A required arcade group file is not available locally.';
    }
  }
  for (const [primary, members] of knownGroups) {
    if (
      !/\.zip$/i.test(primary) ||
      byPath.has(primary) ||
      archives.has(primary.slice(0, -4).toLowerCase())
    )
      continue;
    for (const member of members) {
      const file = byPath.get(member);
      if (file && isArcade(file) && /\.chd$/i.test(member)) {
        file.groupMembers = [...members];
        file.groupError = 'The arcade ZIP primary is missing. Reconnect it and rescan.';
      }
    }
  }
  return edges;
}
