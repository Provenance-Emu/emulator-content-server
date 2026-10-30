export interface CueMember {
  id: string;
  relativePath: string;
  size: number;
  availability?: string;
}
export const MAX_CUE_BYTES = 64 * 1024;
export const MAX_MEDIA_FILES = 128;
function hasControl(value: string, allowWhitespace = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && !(allowWhitespace && [9, 10, 13].includes(code))) || code === 127)
      return true;
  }
  return false;
}
function resolvePath(value: string, parent: string[] = []): string {
  const path = value.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || path.includes(':') || hasControl(path))
    throw new Error('CUE reference must stay inside the disc group');
  const parts = [...parent];
  for (const part of path.split('/')) {
    if (part === '..') {
      if (!parts.length) throw new Error('CUE reference escapes the disc group');
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  if (!parts.length) throw new Error('Invalid CUE reference');
  return parts.join('/');
}
/** Pure planning: content is fetched by authorized IDs, never by CUE-supplied URLs.
 * Flattening names avoids exposing source paths or granting arbitrary MEMFS writes. */
export function planCue(
  bytes: Uint8Array,
  entry: string,
  members: CueMember[],
  limit: number,
): { content: Uint8Array<ArrayBuffer>; files: { id: string; path: string; size: number }[] } {
  if (!bytes.length || bytes.length > MAX_CUE_BYTES)
    throw new Error('CUE descriptor exceeds 64 KiB');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512 * 1024 * 1024)
    throw new Error('Invalid disc size limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  if (hasControl(text, true)) throw new Error('Invalid CUE descriptor');
  const descriptor = resolvePath(entry);
  const parent = descriptor.split('/').slice(0, -1);
  const available = new Map<string, CueMember>();
  for (const member of members) {
    const key = resolvePath(member.relativePath).toLowerCase();
    if (available.has(key)) throw new Error('Disc member names are ambiguous');
    available.set(key, member);
  }
  const files: { id: string; path: string; size: number }[] = [];
  const selected = new Map<string, string>();
  const lines = text.split(/\r?\n/).map((line) => {
    if (!/^\s*FILE\b/i.test(line)) return line;
    const match = /^(\s*)FILE\s+(?:"([^"]+)"|([^"\r\n]+?))\s+BINARY\s*$/i.exec(line);
    if (!match) throw new Error('Only CUE/BIN files with BINARY tracks are supported');
    const reference = resolvePath(match[2] ?? match[3] ?? '', parent);
    const member = available.get(reference.toLowerCase());
    if (!member || reference.toLowerCase() === descriptor.toLowerCase())
      throw new Error('CUE track is missing from this disc group');
    if (member.availability !== undefined && member.availability !== 'local')
      throw new Error('CUE track is not available locally; download it on the server first');
    if (!Number.isSafeInteger(member.size) || member.size < 1 || member.size > limit)
      throw new Error('Invalid CUE track size');
    let name = selected.get(member.id);
    if (!name) {
      if (files.length >= MAX_MEDIA_FILES - 1) throw new Error('Too many CUE track files');
      name = `track-${String(files.length).padStart(3, '0')}.bin`;
      files.push({ id: member.id, path: `/ecs/content/${name}`, size: member.size });
      selected.set(member.id, name);
    }
    return `${match[1] ?? ''}FILE "${name}" BINARY`;
  });
  if (!files.length || !/^\s*TRACK\s+(?:0?[1-9]|[1-9]\d)\s+/im.test(text))
    throw new Error('CUE descriptor has no supported tracks');
  const content = new TextEncoder().encode(lines.join('\n'));
  if (content.length + files.reduce((sum, file) => sum + file.size, 0) > limit)
    throw new Error('Complete disc exceeds this emulator’s content size limit');
  return { content, files };
}
