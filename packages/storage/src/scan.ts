import { readdir, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { AssetKind } from '@ecs/domain';
import { type Availability, fileAvailability, type Medium, probeRoot } from './volume.js';

export interface ScannedFile {
  relativePath: string;
  displayName: string;
  size: number;
  blocks: number;
  kind: AssetKind;
  systemId: string | null;
  availability: Availability;
}

const SYSTEMS: Record<string, string> = {
  nes: 'com.provenance.nes',
  unf: 'com.provenance.nes',
  snes: 'com.provenance.snes',
  sfc: 'com.provenance.snes',
  smc: 'com.provenance.snes',
  gb: 'com.provenance.gb',
  gbc: 'com.provenance.gbc',
  gba: 'com.provenance.gba',
  n64: 'com.provenance.n64',
  z64: 'com.provenance.n64',
  v64: 'com.provenance.n64',
  md: 'com.provenance.genesis',
  gen: 'com.provenance.genesis',
  smd: 'com.provenance.genesis',
  genesis: 'com.provenance.genesis',
  nds: 'com.provenance.ds',
  ds: 'com.provenance.ds',
  psx: 'com.provenance.psx',
  ps1: 'com.provenance.psx',
  cue: 'com.provenance.psx',
};

const ROM_EXTENSIONS = new Set([
  'nes',
  'unf',
  'sfc',
  'smc',
  'gb',
  'gbc',
  'gba',
  'n64',
  'z64',
  'v64',
  'md',
  'gen',
  'smd',
  'nds',
  'cue',
]);

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
  await walk(root, root, probe.medium, files);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { medium: probe.medium, online: true, files };
}

export function inferSource(relativePath: string): { kind: AssetKind; systemId: string | null } {
  const parts = relativePath.split('/');
  const base = parts.at(-1) ?? relativePath;
  const extension = extensionOf(base);
  const folders = parts.slice(0, -1).map((part) => part.toLowerCase());
  const hinted = folders.map((folder) => SYSTEMS[folder]).find((id) => id !== undefined) ?? null;
  if (folders.some((folder) => folder === 'bios' || folder === 'bioses')) {
    return { kind: 'bios', systemId: SYSTEMS[extension] ?? hinted };
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
  if (
    folders.some((folder) => folder === 'artwork' || folder === 'boxart' || folder === 'covers')
  ) {
    return { kind: 'artwork', systemId: hinted };
  }
  if (ROM_EXTENSIONS.has(extension)) {
    return { kind: 'rom', systemId: SYSTEMS[extension] ?? hinted };
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
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(full);
      } catch {
        continue;
      }
      if (!contained(root, target)) continue;
      const linked = await stat(target);
      if (linked.isDirectory()) await walk(root, target, medium, files);
      else if (linked.isFile()) files.push(await describe(root, target, medium));
      continue;
    }
    if (entry.isDirectory()) {
      await walk(root, full, medium, files);
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(await describe(root, full, medium));
  }
}

async function describe(root: string, full: string, medium: Medium): Promise<ScannedFile> {
  const file = await stat(full);
  const blocks = typeof file.blocks === 'number' ? file.blocks : 1;
  const relativePath = relative(root, full).split(sep).join('/');
  const inferred = inferSource(relativePath);
  return {
    relativePath,
    displayName: relativePath.split('/').at(-1) ?? relativePath,
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
