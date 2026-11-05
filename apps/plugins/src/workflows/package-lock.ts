import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

/** Backup and package pointer mutations share a kernel-released lock, separate from serving. */
export async function lockWorkflowPackages(directory: string): Promise<() => void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await lstat(directory);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      ((root.mode & 0o077) !== 0 || (process.getuid && root.uid !== process.getuid())))
  )
    throw new Error('Workflow packages require a private directory');
  const path = join(directory, 'package-lock.sqlite');
  try {
    const file = await open(path, 'wx', 0o600);
    await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  )
    throw new Error('Invalid workflow package lock');
  const db = new DatabaseSync(path);
  const deadline = Date.now() + 5000;
  try {
    db.exec('PRAGMA busy_timeout=0');
    for (;;) {
      try {
        db.exec('BEGIN EXCLUSIVE');
        break;
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if (![5, 6].includes(code ?? 0) || Date.now() >= deadline) throw error;
        await delay(25);
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return () => {
    try {
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  };
}
