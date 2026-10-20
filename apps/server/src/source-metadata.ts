import { stat } from 'node:fs/promises';

/** Metadata only: never open a cloud placeholder to calculate a content hash. */
export async function sourceMetadata(path: string, id: string) {
  const info = await stat(path, { bigint: true });
  if (!info.isFile()) throw new Error('Source is not a regular file');
  return {
    size: Number(info.size),
    modifiedAt: info.mtime.toISOString(),
    // Filesystem metadata is a weak validator, never safe for If-Range recombination.
    etag: `W/"source-${id}-${info.size}-${info.mtimeNs}-${info.ctimeNs}-${info.dev}-${info.ino}"`,
  };
}
