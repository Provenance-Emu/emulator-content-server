import { open } from 'node:fs/promises';
import { posix } from 'node:path';
import { resolveInside } from './paths.js';
import type { ScannedFile } from './scan.js';

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_MEMBERS = 512;
const DESCRIPTORS = new Set(['cue', 'm3u', 'gdi', 'ccd']);
const extension = (path: string) => path.split('.').at(-1)?.toLowerCase() ?? '';

/** Only small local descriptors are opened by an explicit scan, never ROM/track bytes. */
export async function groupDiscs(
  root: string,
  files: ScannedFile[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  let foldedPaths: Map<string, string | null> | undefined;
  function indexedPath(target: string): string | null {
    if (byPath.has(target)) return target;
    if (!foldedPaths) {
      foldedPaths = new Map();
      for (const path of byPath.keys()) {
        const key = path.toLowerCase();
        foldedPaths.set(key, foldedPaths.has(key) ? null : path);
      }
    }
    return foldedPaths.get(target.toLowerCase()) ?? null;
  }
  const edges = new Map<string, string[]>();
  for (const file of files) {
    signal?.throwIfAborted();
    file.groupAnchor = null;
    file.groupMembers = [];
    file.groupError = null;
    if (!DESCRIPTORS.has(extension(file.relativePath))) continue;
    try {
      if (file.availability !== 'local')
        throw new Error('Disc descriptor is not available locally.');
      if (file.size > MAX_DESCRIPTOR_BYTES) throw new Error('Disc descriptor exceeds 64 KiB.');
      const path = await resolveInside(root, file.relativePath, { pinnedRoot: true });
      const handle = await open(path, 'r');
      let text: string;
      try {
        const buffer = Buffer.alloc(MAX_DESCRIPTOR_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_DESCRIPTOR_BYTES) throw new Error('Disc descriptor exceeds 64 KiB.');
        text = buffer
          .subarray(0, bytesRead)
          .toString('utf8')
          .replace(/^\uFEFF/, '');
      } finally {
        await handle.close();
      }
      const refs = references(file.relativePath, text, byPath);
      if (refs.length === 0 || refs.length > MAX_MEMBERS)
        throw new Error('Disc descriptor has no valid members or too many members.');
      const paths = refs.map((ref) => {
        const normalized = ref.replaceAll('\\', '/');
        if (!normalized || normalized.startsWith('/') || /[:\0]/.test(normalized))
          throw new Error('Disc reference must stay inside the registered folder.');
        const target = posix.normalize(posix.join(posix.dirname(file.relativePath), normalized));
        if (target === '..' || target.startsWith('../'))
          throw new Error('Disc member is missing or outside the registered folder.');
        const indexed = indexedPath(target);
        if (!indexed) throw new Error('Disc member is missing or has ambiguous filename casing.');
        return indexed;
      });
      edges.set(file.relativePath, [...new Set(paths)]);
    } catch (error) {
      signal?.throwIfAborted();
      file.groupError =
        error instanceof Error && !('code' in error)
          ? error.message
          : 'Disc descriptor could not be read. Rescan after reconnecting the folder.';
    }
  }
  function expand(path: string, visiting: Set<string>, output: Set<string>): void {
    if (visiting.has(path) || visiting.size >= 8)
      throw new Error('Disc references are cyclic or nested too deeply.');
    if (output.has(path)) return;
    if (output.size >= MAX_MEMBERS) throw new Error('Disc group has too many members.');
    output.add(path);
    const file = byPath.get(path);
    if (file?.groupError) throw new Error('A disc member has an invalid descriptor.');
    const refs = edges.get(path);
    if (!refs) return;
    visiting.add(path);
    for (const ref of refs) expand(ref, visiting, output);
    visiting.delete(path);
  }
  const groups = new Map<string, string[]>();
  for (const [path] of edges) {
    try {
      const members = new Set<string>();
      expand(path, new Set(), members);
      groups.set(path, [...members]);
    } catch (error) {
      const file = byPath.get(path);
      if (file) file.groupError = error instanceof Error ? error.message : 'Invalid disc group.';
    }
  }
  // Only top-level playlists/descriptors become collection entries. A shared track can
  // still appear in multiple ZIP manifests; groupAnchor only controls collection visibility.
  const nested = new Set([...groups.values()].flatMap((members) => members.slice(1)));
  for (const [path, members] of groups) {
    if (nested.has(path)) continue;
    const anchor = byPath.get(path);
    if (!anchor) continue;
    anchor.groupMembers = members;
    for (const member of members.slice(1)) {
      const file = byPath.get(member);
      if (file && !file.groupAnchor) file.groupAnchor = path;
    }
  }
}

function references(path: string, text: string, files: Map<string, ScannedFile>): string[] {
  const ext = extension(path);
  if (ext === 'cue') {
    const refs = [
      ...text.matchAll(/^\s*FILE\s+(?:"([^"]+)"|(.+?))\s+(?:BINARY|MOTOROLA|WAVE|AIFF|MP3)\s*$/gim),
    ].map((m) => m[1] ?? m[2] ?? '');
    if (text.split(/\r?\n/).filter((line) => /^\s*FILE\b/i.test(line)).length !== refs.length)
      throw new Error('CUE file description is invalid.');
    return refs;
  }
  if (ext === 'm3u')
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  if (ext === 'gdi') {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const count = Number(lines.shift());
    if (!Number.isInteger(count) || count < 1 || count !== lines.length)
      throw new Error('GDI track count is invalid.');
    return lines.map((line) => {
      const match = /^\d+\s+\d+\s+\d+\s+\d+\s+(?:"([^"]+)"|(.+?))\s+\d+$/.exec(line);
      if (!match) throw new Error('GDI track description is invalid.');
      return match[1] ?? match[2] ?? '';
    });
  }
  const stem = path.replace(/\.ccd$/i, '');
  const sibling = (suffix: string) => {
    const matches = [...files.keys()].filter(
      (name) => name.toLowerCase() === `${stem}.${suffix}`.toLowerCase(),
    );
    if (matches.length > 1) throw new Error('CloneCD companions have ambiguous names.');
    return matches[0];
  };
  const image = sibling('img');
  if (!image) throw new Error('CloneCD image is missing.');
  const sub = sibling('sub');
  return [posix.basename(image), ...(sub ? [posix.basename(sub)] : [])];
}
