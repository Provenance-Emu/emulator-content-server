import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type Medium = 'internal' | 'removable' | 'network' | 'icloud';
export type Availability = 'local' | 'evicted' | 'offline';

const NETWORK_FSTYPES = new Set(['smbfs', 'nfs', 'webdav', 'cifs', 'afpfs', '9p', 'fuse.sshfs']);

export interface MediumInput {
  path: string;
  platform: NodeJS.Platform;
  home: string;
  sameDeviceAsSystem: boolean;
  fstype: string | null;
}

/**
 * Classifies a folder from its path and mount. A file-provider path stays
 * `icloud` even when it also sits on an external-looking prefix.
 */
export function classifyMedium(input: MediumInput): Medium {
  const path = input.path.replaceAll('\\', '/');
  if (path.includes('/Library/Mobile Documents/') || path.includes('/Library/CloudStorage/')) {
    return 'icloud';
  }
  if (input.fstype && NETWORK_FSTYPES.has(input.fstype)) return 'network';
  if (input.platform === 'win32') {
    if (path.startsWith('//')) return 'network';
    return input.sameDeviceAsSystem ? 'internal' : 'removable';
  }
  if (
    path.startsWith('/media/') ||
    path.startsWith('/run/media/') ||
    (path.startsWith('/Volumes/') && !input.sameDeviceAsSystem)
  ) {
    return 'removable';
  }
  if (!input.sameDeviceAsSystem && path.startsWith('/mnt/')) return 'removable';
  return 'internal';
}

/**
 * `evicted` is a placeholder: the name and size are present, and no blocks are
 * allocated, on a file-provider volume. Any other present file is `local`.
 * A missing volume is `offline`. Sparse files on an internal disk stay `local`.
 */
export function fileAvailability(input: {
  online: boolean;
  medium: Medium;
  size: number;
  blocks: number;
}): Availability {
  if (!input.online) return 'offline';
  if (input.medium === 'icloud' && input.size > 0 && input.blocks === 0) return 'evicted';
  return 'local';
}

export async function probeRoot(path: string): Promise<{ medium: Medium; online: boolean }> {
  const hints = {
    path,
    platform: platform(),
    home: homedir(),
    sameDeviceAsSystem: false,
    fstype: null as string | null,
  };
  try {
    const [file, system] = await Promise.all([stat(path), stat(homedir())]);
    if (!file.isDirectory()) return { medium: classifyMedium(hints), online: false };
    hints.sameDeviceAsSystem = file.dev === system.dev;
    hints.fstype = await readFstype(path);
    return { medium: classifyMedium(hints), online: true };
  } catch {
    return { medium: classifyMedium(hints), online: false };
  }
}

/**
 * Names a file without opening it. `stat` is enough for size and allocated
 * blocks; opening a placeholder would start a provider download.
 */
export async function probeFile(
  path: string,
  medium: Medium,
  online: boolean,
): Promise<{ availability: Availability; size: number; blocks: number }> {
  if (!online) return { availability: 'offline', size: 0, blocks: 0 };
  try {
    const file = await stat(path);
    const blocks = typeof file.blocks === 'number' ? file.blocks : 1;
    return {
      availability: fileAvailability({ online: true, medium, size: file.size, blocks }),
      size: file.size,
      blocks,
    };
  } catch {
    return { availability: 'offline', size: 0, blocks: 0 };
  }
}

async function readFstype(path: string): Promise<string | null> {
  if (platform() === 'win32') return null;
  try {
    const args = platform() === 'darwin' ? ['-f', '%T', path] : ['-c', '%T', path];
    const { stdout } = await exec('stat', args, { timeout: 2000 });
    const name = stdout.trim().toLowerCase();
    return name || null;
  } catch {
    return null;
  }
}
