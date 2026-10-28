import { opendir, realpath, stat } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { type AssetKind, DomainError, detectRomSystem, isRomExtension } from '@ecs/domain';
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
export async function inspectRoot(
  rootPath: string,
  options: { pinnedRoot?: boolean; signal?: AbortSignal } = {},
): Promise<{
  medium: Medium;
  online: boolean;
  files: ScannedFile[];
}> {
  options.signal?.throwIfAborted();
  const probe = await probeRoot(rootPath);
  if (!probe.online) return { medium: probe.medium, online: false, files: [] };
  const root = await realpath(rootPath);
  if (options.pinnedRoot && root !== resolve(rootPath))
    throw new DomainError('invalid-body', 400, 'Registered folder has changed');
  const files: ScannedFile[] = [];
  await walk(root, root, probe.medium, files, new Set<string>(), options.signal);
  options.signal?.throwIfAborted();
  await groupDiscs(root, files, options.signal);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { medium: probe.medium, online: true, files };
}

export function inferSource(relativePath: string): { kind: AssetKind; systemId: string | null } {
  const parts = relativePath.split('/');
  const base = parts.at(-1) ?? relativePath;
  const extension = extensionOf(base);
  const folders = parts.slice(0, -1).map((part) => part.toLowerCase());
  const hinted = detectRomSystem(relativePath).systemId;
  if (
    /^\[bios\](?:\s|$)/i.test(base) ||
    folders.some((folder) => folder === 'bios' || folder === 'bioses')
  ) {
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
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const canonical = await realpath(dir);
  if (!contained(root, canonical) || visited.has(canonical)) return;
  visited.add(canonical);
  // Avoid a second directory-sized allocation and keep metadata IO conservative
  // on removable/provider volumes; a little overlap helps local/network latency.
  const concurrency = medium === 'internal' ? 4 : medium === 'network' ? 2 : 1;
  const batch: (() => Promise<void>)[] = [];
  const flush = async () => {
    const results = await Promise.allSettled(batch.splice(0).map((work) => work()));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  };
  const entries = await opendir(canonical);
  for await (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.name.startsWith('.')) continue;
    const full = resolve(canonical, entry.name);
    if (entry.isSymbolicLink()) {
      await flush();
      let target: string;
      try {
        target = await realpath(full);
      } catch {
        continue;
      }
      if (!contained(root, target)) continue;
      const linked = await stat(target);
      if (linked.isDirectory()) await walk(root, target, medium, files, visited, signal);
      else if (linked.isFile()) await addFile(root, target, medium, files, visited, signal);
      continue;
    }
    if (entry.isDirectory()) {
      await flush();
      await walk(root, full, medium, files, visited, signal);
      continue;
    }
    if (!entry.isFile()) continue;
    batch.push(() => addFile(root, full, medium, files, visited, signal));
    if (batch.length >= concurrency) await flush();
  }
  await flush();
}

async function addFile(
  root: string,
  full: string,
  medium: Medium,
  files: ScannedFile[],
  visited: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const canonical = await realpath(full);
  if (!contained(root, canonical) || visited.has(canonical)) return;
  visited.add(canonical);
  const file = await describe(root, canonical, medium);
  signal?.throwIfAborted();
  files.push(file);
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
