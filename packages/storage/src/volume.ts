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
    // Local lookups do not need a subprocess per source; mount facts are shared
    // briefly for other devices, while presence/identity is always freshly statted.
    if (!hints.sameDeviceAsSystem) hints.fstype = await readFstype(path, String(file.dev));
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

const mountTypes = new Map<string, { expires: number; value: Promise<string | null> }>();

/** Parse mount facts without confusing BSD stat's file-type indicator with a filesystem name. */
export function darwinMountType(path: string, listing: string): string | null {
  let result: string | null = null,
    longest = -1;
  for (const line of listing.split('\n')) {
    const match = / on (.+) \(([^, )]+)(?:[, )])/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const mount = match[1];
    if (
      (path === mount || path.startsWith(mount.endsWith('/') ? mount : mount + '/')) &&
      mount.length > longest
    ) {
      longest = mount.length;
      result = match[2].toLowerCase();
    }
  }
  return result;
}
async function readFstype(path: string, device: string): Promise<string | null> {
  if (platform() === 'win32') return null;
  const key = `${platform()}:${device}`,
    now = Date.now(),
    cached = mountTypes.get(key);
  if (cached && cached.expires > now) return cached.value;
  const value = (async () => {
    try {
      if (platform() === 'darwin') {
        const { stdout } = await exec('/sbin/mount', [], { timeout: 2000, maxBuffer: 1024 * 1024 });
        return darwinMountType(path, stdout);
      }
      const { stdout } = await exec('stat', ['-f', '-c', '%T', path], { timeout: 2000 });
      return stdout.trim().toLowerCase() || null;
    } catch {
      return null;
    }
  })();
  mountTypes.delete(key);
  mountTypes.set(key, { expires: now + 30000, value });
  if (mountTypes.size > 64) mountTypes.delete(mountTypes.keys().next().value ?? '');
  return value;
}
