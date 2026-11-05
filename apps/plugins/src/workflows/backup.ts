import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { lockWorkflowPackages } from './package-lock.js';
import { openWorkflowState } from './state.js';
import { lockWorkflowHost } from './transport.js';

interface BackupFile {
  path: string;
  size: number;
  sha256: string;
}
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 10_000;

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))
  )
    throw new Error('Workflow backup requires a private directory');
}
async function bytes(path: string, maximum = MAX_BYTES): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximum) throw new Error('Invalid workflow backup file');
    const result = await file.readFile();
    if (result.length > maximum) throw new Error('Workflow backup file exceeds limit');
    return result;
  } finally {
    await file.close();
  }
}
function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function safePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length <= 4096 &&
    !isAbsolute(path) &&
    !/[\\:]/.test(path) &&
    !path.includes(String.fromCharCode(0)) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..') &&
    (path === 'workflow-host.sqlite' ||
      path.startsWith('packages/') ||
      path.startsWith('activations/') ||
      path.startsWith('activation-grants/'))
  );
}
async function assertNewDestination(source: string, destination: string): Promise<void> {
  const within = relative(resolve(source), resolve(destination));
  if (
    !within ||
    (!within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(within))
  )
    throw new Error('Workflow backup destination must be outside its source');
  await mkdir(destination, { mode: 0o700 });
  await privateDirectory(destination);
}

/** Stop the host first; its OS-backed lock also excludes another backup process. */
export async function exportWorkflowHostState(source: string, destination: string): Promise<void> {
  await privateDirectory(source);
  const unlock = await lockWorkflowHost(source);
  let created = false;
  let unlockPackages: (() => void) | undefined;
  try {
    unlockPackages = await lockWorkflowPackages(source);
    await assertNewDestination(source, destination);
    created = true;
    const state = await openWorkflowState(source);
    try {
      state.backupTo(join(destination, 'workflow-host.sqlite'));
    } finally {
      state.close();
    }
    await chmod(join(destination, 'workflow-host.sqlite'), 0o600);
    const files: BackupFile[] = [];
    let total = 0;
    async function retain(path: string, value: Buffer): Promise<void> {
      total += value.length;
      if (files.length >= MAX_FILES || total > MAX_BYTES)
        throw new Error('Workflow backup exceeds limit');
      files.push({ path, size: value.length, sha256: hash(value) });
    }
    await retain('workflow-host.sqlite', await bytes(join(destination, 'workflow-host.sqlite')));
    async function copyTree(path: string): Promise<void> {
      const absolute = join(source, path);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error('Workflow backup refuses symlinks');
      if (info.isDirectory()) {
        for (const name of await readdir(absolute)) await copyTree(`${path}/${name}`);
      } else {
        if (!safePath(path)) throw new Error('Invalid workflow backup path');
        const value = await bytes(absolute, MAX_BYTES - total);
        await retain(path, value);
        await mkdir(dirname(join(destination, path)), { recursive: true, mode: 0o700 });
        await writeFile(join(destination, path), value, { flag: 'wx', mode: 0o600 });
      }
    }
    for (const path of ['packages', 'activations', 'activation-grants']) {
      try {
        await lstat(join(source, path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      await copyTree(path);
    }
    await writeFile(
      join(destination, 'backup.json'),
      `${JSON.stringify({ version: 1, files })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    unlockPackages?.();
    await unlock();
  }
}

/** Restore into a new private directory. Unfinished history always requires owner reconciliation. */
export async function restoreWorkflowHostState(source: string, destination: string): Promise<void> {
  await privateDirectory(source);
  const manifest = JSON.parse(
    (await bytes(join(source, 'backup.json'), 4 * 1024 * 1024)).toString('utf8'),
  ) as {
    version?: unknown;
    files?: BackupFile[];
  };
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > MAX_FILES
  )
    throw new Error('Invalid workflow backup manifest');
  const names = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    if (
      !file ||
      !safePath(file.path) ||
      names.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error('Invalid workflow backup entry');
    total += file.size;
    names.add(file.path);
  }
  if (!names.has('workflow-host.sqlite') || total > MAX_BYTES)
    throw new Error('Incomplete workflow backup');
  await assertNewDestination(source, destination);
  try {
    for (const file of manifest.files) {
      // Refuse intermediate directory links as well as final-file links.
      let parent = dirname(file.path);
      while (parent !== '.') {
        const info = await lstat(join(source, parent));
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('Invalid workflow backup directory');
        parent = dirname(parent);
      }
      const value = await bytes(join(source, file.path), file.size);
      if (value.length !== file.size || hash(value) !== file.sha256)
        throw new Error('Workflow backup checksum mismatch');
      await mkdir(dirname(join(destination, file.path)), { recursive: true, mode: 0o700 });
      await writeFile(join(destination, file.path), value, { flag: 'wx', mode: 0o600 });
    }
    const state = await openWorkflowState(destination);
    try {
      state.requireRecoveryAfterRestore();
    } finally {
      state.close();
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
