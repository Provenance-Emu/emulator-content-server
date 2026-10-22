import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { type AssetKind, detectRomSystem, isRomExtension } from '@ecs/domain';
import { groupDiscs } from './disc-groups.js';
import { type Availability, fileAvailability, type Medium, probeRoot } from './volume.js';

export interface ScannedFile {
  relativePath: string;
  displayName: string;
  size: number;
  blocks: number;
  kind: AssetKind;
  systemId: string | null;
  availability: Availability;
  filesystemIdentity?: string | null;
  mtimeMs?: number | null;
  groupAnchor?: string | null;
  groupMembers?: string[];
  groupError?: string | null;
}

/**
 * Reads a registered folder in place. Names and sizes come from `stat`.
 * File bytes are not opened, so a placeholder is not downloaded.
 */
export async function inspectRoot(rootPath: string): Promise<{
  medium: Medium;
  online: boolean;
  files: ScannedFile[];
}> {
  const probe = await probeRoot(rootPath);
  if (!probe.online) return { medium: probe.medium, online: false, files: [] };
  const root = await realpath(rootPath);
  const files: ScannedFile[] = [];
  await walk(root, root, probe.medium, files, new Set<string>());
  await groupDiscs(root, files);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { medium: probe.medium, online: true, files };
}

export function inferSource(relativePath: string): { kind: AssetKind; systemId: string | null } {
  const parts = relativePath.split('/');
  const base = parts.at(-1) ?? relativePath;
  const extension = extensionOf(base);
  const folders = parts.slice(0, -1).map((part) => part.toLowerCase());
  const hinted = detectRomSystem(relativePath).systemId;
  if (folders.some((folder) => folder === 'bios' || folder === 'bioses')) {
    return { kind: 'bios', systemId: hinted };
  }
  if (extension === 'state' || extension === 'ss') {
    return { kind: 'save_state', systemId: hinted };
  }
  if (extension === 'sav' || extension === 'srm') {
    return { kind: 'battery_save', systemId: hinted };
  }
  if (folders.some((folder) => folder.includes('screenshot'))) {
    return { kind: 'screenshot', systemId: hinted };
  }
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension))
    return { kind: 'artwork', systemId: hinted };
  if (
    folders.some((folder) => folder === 'artwork' || folder === 'boxart' || folder === 'covers')
  ) {
    return { kind: 'artwork', systemId: hinted };
  }
  if (isRomExtension(relativePath)) {
    return { kind: 'rom', systemId: hinted };
  }
  if (extension === 'zip' || extension === '7z' || extension === 'iso' || extension === 'chd') {
    return { kind: 'rom', systemId: hinted };
  }
  return { kind: 'system_file', systemId: hinted };
}

async function walk(
  root: string,
  dir: string,
  medium: Medium,
  files: ScannedFile[],
  visited: Set<string>,
): Promise<void> {
  const canonical = await realpath(dir);
  if (!contained(root, canonical) || visited.has(canonical)) return;
  visited.add(canonical);
  const entries = await readdir(canonical, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = resolve(canonical, entry.name);
    if (entry.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(full);
      } catch {
        continue;
      }
      if (!contained(root, target)) continue;
      const linked = await stat(target);
      if (linked.isDirectory()) await walk(root, target, medium, files, visited);
      else if (linked.isFile()) await addFile(root, target, medium, files, visited);
      continue;
    }
    if (entry.isDirectory()) {
      await walk(root, full, medium, files, visited);
      continue;
    }
    if (!entry.isFile()) continue;
    await addFile(root, full, medium, files, visited);
  }
}

async function addFile(
  root: string,
  full: string,
  medium: Medium,
  files: ScannedFile[],
  visited: Set<string>,
): Promise<void> {
  const canonical = await realpath(full);
  if (!contained(root, canonical) || visited.has(canonical)) return;
  visited.add(canonical);
  files.push(await describe(root, canonical, medium));
}

async function describe(root: string, full: string, medium: Medium): Promise<ScannedFile> {
  const facts = await stat(full, { bigint: true });
  const file = { size: Number(facts.size), blocks: Number(facts.blocks) };
  const blocks = typeof file.blocks === 'number' ? file.blocks : 1;
  const relativePath = relative(root, full).split(sep).join('/');
  const inferred = inferSource(`${basename(root)}/${relativePath}`);
  return {
    relativePath,
    displayName: relativePath.split('/').at(-1) ?? relativePath,
    filesystemIdentity:
      facts.dev >= 0n && facts.ino > 0n && facts.birthtimeNs > 0n
        ? `${facts.dev}:${facts.ino}:${facts.birthtimeNs}`
        : null,
    mtimeMs: Number(facts.mtimeNs) / 1e6,
    size: file.size,
    blocks,
    kind: inferred.kind,
    systemId: inferred.systemId,
    availability: fileAvailability({ online: true, medium, size: file.size, blocks }),
  };
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}
