import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { DomainError } from '@ecs/domain';

export interface FolderEntry {
  name: string;
  path: string;
}

export interface FolderPlace {
  label: string;
  path: string;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  entries: FolderEntry[];
  places: FolderPlace[];
}

const MOUNT_POINTS: readonly FolderPlace[] = [
  { label: 'Volumes', path: '/Volumes' },
  { label: 'Media', path: '/media' },
  { label: 'Mounts', path: '/mnt' },
  { label: 'Shares', path: '/srv' },
];

/**
 * Where iCloud Drive keeps its folders on a Mac that is signed in to iCloud. It sits under the
 * hidden `Library` folder, so nobody finds it by browsing. Each app's folder is offered by name,
 * pointing at its games where it keeps them apart from saves and system files.
 */
const ICLOUD_FOLDERS: ReadonlyArray<{ label: string; folder: string; games?: string }> = [
  { label: 'iCloud Drive', folder: 'com~apple~CloudDocs' },
  { label: 'Provenance in iCloud', folder: 'iCloud~org~provenance-emu~provenance', games: 'ROMs' },
  { label: 'iCube in iCloud', folder: 'iCloud~com~joemattiello~iCube' },
  { label: 'iFly in iCloud', folder: 'iCloud~com~joemattiello~iFly' },
];

/**
 * Lists the directories inside one directory on the machine running the server.
 *
 * This exists because a folder to register lives on the server, which is not
 * necessarily the machine holding the browser. A file input would offer the
 * wrong filesystem, and it would hand back names relative to a sandbox rather
 * than the absolute path the server needs.
 *
 * Only directory names come back. No file is listed, nothing is read, and the
 * caller must be the owner, who can already register any folder and have the
 * server read it.
 */
export async function listFolders(candidate: string | null): Promise<FolderListing> {
  const requested = candidate ?? homedir();
  if (!isAbsolute(requested)) {
    throw new DomainError('invalid-path', 400, 'A folder to browse must be an absolute path');
  }
  let here: string;
  try {
    here = await realpath(requested);
  } catch {
    throw new DomainError('not-found', 404, 'That folder does not exist');
  }
  if (!(await stat(here)).isDirectory()) {
    throw new DomainError('invalid-path', 400, 'That path is not a folder');
  }
  const parent = dirname(here);
  return {
    path: here,
    parent: parent === here ? null : parent,
    entries: await directoriesIn(here),
    places: await startingPlaces(),
  };
}

/**
 * Where browsing starts, so the first screen is not an empty path box. The home
 * directory is always offered and the usual mount points are offered when they
 * exist, which is where an external drive or a network share shows up.
 */
export async function startingPlaces(home = homedir()): Promise<FolderPlace[]> {
  const places: FolderPlace[] = [{ label: 'Home', path: home }];
  const root = parse(home).root;
  if (root) places.push({ label: 'Root', path: root });
  for (const mount of MOUNT_POINTS) {
    if (await isDirectory(mount.path)) places.push(mount);
  }
  // Present only on a Mac signed in to iCloud, and only for apps that have put something there.
  const drive = join(home, 'Library', 'Mobile Documents');
  for (const { label, folder, games } of ICLOUD_FOLDERS) {
    const base = join(drive, folder);
    const preferred = games ? join(base, games) : base;
    if (await isDirectory(preferred)) places.push({ label, path: preferred });
    else if (games && (await isDirectory(base))) places.push({ label, path: base });
  }
  return places;
}

async function directoriesIn(here: string): Promise<FolderEntry[]> {
  let listing: Dirent[];
  try {
    listing = await readdir(here, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new DomainError('forbidden', 403, 'The server is not allowed to read that folder');
    }
    throw error;
  }
  const entries: FolderEntry[] = [];
  for (const entry of listing) {
    // Hidden entries are noise when the point is to find a game folder.
    if (entry.name.startsWith('.')) continue;
    const path = join(here, entry.name);
    // A symlink reports itself as a link rather than a directory, and a library
    // on an external drive is often reached through one, so it is followed.
    const directory = entry.isDirectory() || (entry.isSymbolicLink() && (await isDirectory(path)));
    if (directory) entries.push({ name: entry.name, path });
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

async function isDirectory(path: string): Promise<boolean> {
  const found = await stat(path).catch(() => null);
  return found?.isDirectory() === true;
}
