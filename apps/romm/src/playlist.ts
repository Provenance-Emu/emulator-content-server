import { posix } from 'node:path';
import { Readable } from 'node:stream';
import type { ZipMember } from '@ecs/storage';
import { GatewayError, type Upstream } from './upstream.js';

export interface DownloadMember {
  name: string;
  path: string;
  size: number;
}

const MAX_PLAYLIST_BYTES = 64 * 1024;
const SIMPLE_DISC = /\.(?:iso|gcm|rvz|gcz|wbfs|ciso|wia|chd|cso|img|bin)$/i;

/** Manic matches each playlist line to an imported file's basename. */
export async function manicPlaylist(
  ecs: Upstream,
  files: DownloadMember[],
  open: (file: DownloadMember) => Promise<Readable>,
): Promise<ZipMember[] | null> {
  const [primary, ...discs] = files;
  if (
    !primary ||
    !/\.m3u$/i.test(primary.name) ||
    !discs.length ||
    !discs.every((disc) => SIMPLE_DISC.test(disc.name))
  )
    return null;

  const names = files.map((file) => posix.basename(file.name));
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) return null;

  const response = await ecs.get(primary.path, {
    headers: new Headers({ range: `bytes=0-${MAX_PLAYLIST_BYTES}` }),
  });
  if (!response.ok) await ecs.reject(response);
  const length = Number(response.headers.get('content-length'));
  if (!length || length > MAX_PLAYLIST_BYTES) {
    await response.body?.cancel();
    throw new GatewayError(409, 'The playlist changed or is too large. Rescan its folder.');
  }
  const text = await response.text();
  const directory = posix.dirname(primary.name);
  const byPath = new Map(discs.map((disc) => [disc.name, disc]));
  const refs = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const ordered = refs.map((ref) => {
    const normalized = ref.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.includes(':')) return undefined;
    const target = posix.normalize(posix.join(directory, normalized));
    return byPath.get(target);
  });
  if (ordered.some((disc) => !disc) || new Set(ordered).size !== discs.length) return null;

  const playlist = Buffer.from(
    `${ordered.map((disc) => posix.basename(disc?.name ?? '')).join('\n')}\n`,
  );
  return [
    {
      name: posix.basename(primary.name),
      size: playlist.length,
      open: async () => Readable.from([playlist]),
    },
    ...discs.map((disc) => ({
      name: posix.basename(disc.name),
      size: disc.size,
      open: () => open(disc),
    })),
  ];
}
