import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DomainError } from '@ecs/domain';

export type OrganizationMode = 'copy' | 'move';
export interface OrganizationFile {
  filesystemIdentity: string;
  mtimeMs: number;
  size: number;
  blocks: number;
  validator: string;
  sha256: string;
}
export interface OrganizationPlan {
  sourceRoot: string;
  sourceRelativePath: string;
  targetRoot: string;
  targetRelativePath: string;
  mode: OrganizationMode;
  file: OrganizationFile;
}

/** Portable segments only; no absolute paths, reserved device names, or trailing dots. */
export function portableSegment(value: string, maxBytes = 120): string {
  let segment = value
    .normalize('NFC')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: filesystem segments must exclude control bytes.
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^\.+|[. ]+$/g, '')
    .trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) segment = `_${segment}`;
  let result = '';
  for (const character of Array.from(segment || 'Unknown')) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
    result += character;
  }
  return result;
}

function conflict(message: string): never {
  throw new DomainError('organization-conflict', 409, message);
}

/** Every existing segment must be a real directory/file under the pinned root. */
async function contained(root: string, relativePath: string): Promise<string> {
  if (
    isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((part) => !part || part === '.' || part === '..')
  )
    conflict('Invalid organization path');
  const actualRoot = await realpath(root).catch(() =>
    conflict('Registered folder unavailable; preview again'),
  );
  if (actualRoot !== resolve(root)) conflict('Registered folder changed; preview again');
  let path = root;
  const segments = relativePath.split('/');
  for (let i = 0; i < segments.length; i++) {
    path = join(path, segments[i] ?? '');
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) conflict('Symbolic links cannot be organized');
      if (i < segments.length - 1 && !entry.isDirectory())
        conflict('Target parent is not a folder');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return path;
}

export async function inspectOrganizationFile(path: string): Promise<OrganizationFile> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: NodeJS.ErrnoException) => {
      if (['ENOENT', 'ELOOP', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code ?? ''))
        conflict('Source unavailable or changed; preview again');
      throw error;
    },
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) conflict('Only regular files can be organized');
    if (before.size > 512n * 1024n * 1024n) conflict('Organization supports ROMs up to 512 MB');
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (BigInt(position) > before.size) conflict('Source changed; preview again');
    }
    const after = await handle.stat({ bigint: true });
    const validator = (s: typeof before) =>
      `${s.dev}:${s.ino}:${s.birthtimeNs}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    if (validator(before) !== validator(after)) conflict('Source changed; preview again');
    return {
      filesystemIdentity: `${after.dev}:${after.ino}:${after.birthtimeNs}`,
      mtimeMs: Number(after.mtimeNs) / 1e6,
      size: Number(after.size),
      blocks: Number(after.blocks),
      validator: validator(after),
      sha256: digest.digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  conflict('The destination already exists; choose another folder');
}

export async function previewOrganization(
  sourceRoot: string,
  sourceRelativePath: string,
  targetRoot: string,
  targetRelativePath: string,
  mode: OrganizationMode,
): Promise<OrganizationPlan> {
  const source = await contained(sourceRoot, sourceRelativePath);
  const target = await contained(targetRoot, targetRelativePath);
  await absent(target);
  const file = await inspectOrganizationFile(source);
  if (mode === 'move' && (await lstat(source)).dev !== (await lstat(targetRoot)).dev)
    conflict('Moving between volumes is not supported; use Copy instead');
  return { sourceRoot, sourceRelativePath, targetRoot, targetRelativePath, mode, file };
}

/** Exclusive placement. The caller compensates on a catalog transaction failure. */
export async function applyOrganization(
  plan: OrganizationPlan,
): Promise<{ file: OrganizationFile; rollback(): Promise<void>; finalize(): Promise<void> }> {
  const source = await contained(plan.sourceRoot, plan.sourceRelativePath);
  const target = await contained(plan.targetRoot, plan.targetRelativePath);
  const current = await inspectOrganizationFile(source);
  if (current.validator !== plan.file.validator || current.sha256 !== plan.file.sha256)
    conflict('Source changed; preview again');
  await absent(target);
  // Create one parent at a time, validating existing segments before and after each mkdir.
  const parents = plan.targetRelativePath.split('/').slice(0, -1);
  for (let i = 0; i < parents.length; i++) {
    const parent = parents.slice(0, i + 1).join('/');
    const path = await contained(plan.targetRoot, parent);
    await mkdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await contained(plan.targetRoot, `${parent}/check`);
  }
  await contained(plan.sourceRoot, plan.sourceRelativePath);
  await contained(plan.targetRoot, plan.targetRelativePath);
  let placed: OrganizationFile | undefined;
  let ownedIdentity: string | undefined;
  const identity = async (path: string) => {
    const s = await lstat(path, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink()) conflict('Destination changed during recovery');
    return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
  };
  const rollback = async () => {
    if (!ownedIdentity) return;
    if ((await identity(target)) !== ownedIdentity)
      conflict('Destination changed during recovery; both locations must be inspected');
    await unlink(target);
  };
  const finalize = async () => {
    if (plan.mode !== 'move') return;
    await contained(plan.sourceRoot, plan.sourceRelativePath);
    await contained(plan.targetRoot, plan.targetRelativePath);
    // Claim a pathname atomically before inspecting it. A concurrent manager
    // may replace the old name during hashing; it must never be unlinked using
    // an identity read earlier from that pathname.
    const recovery = await mkdtemp(join(dirname(source), '.ecs-organize-'));
    const claimedPath = join(recovery, 'original');
    let claimed = false;
    try {
      await rename(source, claimedPath);
      claimed = true;
      const original = await inspectOrganizationFile(claimedPath);
      const destination = await inspectOrganizationFile(target);
      if (
        original.filesystemIdentity !== current.filesystemIdentity ||
        original.sha256 !== current.sha256 ||
        destination.filesystemIdentity !== ownedIdentity ||
        destination.sha256 !== current.sha256
      )
        conflict('Original changed during finalization');
      await unlink(claimedPath);
      claimed = false;
    } catch (error) {
      if (claimed) {
        try {
          await link(claimedPath, source); // Restore only into an absent original name.
          await unlink(claimedPath);
          claimed = false;
        } catch {
          throw new DomainError(
            'organization-recovery',
            409,
            `The destination is indexed. Additional original bytes were retained at ${relative(plan.sourceRoot, claimedPath).split('\\').join('/')}; inspect this recovery file before removing it.`,
          );
        }
      }
      throw error;
    } finally {
      if (!claimed) await rmdir(recovery).catch(() => undefined);
    }
  };
  try {
    if (plan.mode === 'move') {
      await link(source, target);
      ownedIdentity = await identity(target);
    } else {
      const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const output = await open(
          target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const created = await output.stat({ bigint: true });
          ownedIdentity = `${created.dev}:${created.ino}:${created.birthtimeNs}`;
          const buffer = Buffer.alloc(1024 * 1024);
          let position = 0;
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
            if (!bytesRead) break;
            let written = 0;
            while (written < bytesRead) {
              const result = await output.write(
                buffer,
                written,
                bytesRead - written,
                position + written,
              );
              if (!result.bytesWritten) throw new Error('Unable to copy file');
              written += result.bytesWritten;
            }
            position += bytesRead;
            if (position > plan.file.size) conflict('Source changed; preview again');
          }
          await output.sync();
        } finally {
          await output.close();
        }
      } finally {
        await input.close();
      }
    }
    placed = await inspectOrganizationFile(target);
    if (placed.sha256 !== plan.file.sha256 || placed.size !== plan.file.size)
      conflict('Copied bytes changed; preview again');
    const after = await inspectOrganizationFile(source);
    // Linking changes ctime; identity, mtime, size and bytes must still agree.
    if (
      after.filesystemIdentity !== current.filesystemIdentity ||
      after.mtimeMs !== current.mtimeMs ||
      after.sha256 !== current.sha256
    )
      conflict('Source changed; preview again');
    return { file: placed, rollback, finalize };
  } catch (error) {
    if (ownedIdentity) await rollback();
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      conflict('The destination already exists; preview again');
    if ((error as NodeJS.ErrnoException).code === 'EXDEV')
      conflict('Moving between volumes is not supported; use Copy instead');
    throw error;
  }
}
