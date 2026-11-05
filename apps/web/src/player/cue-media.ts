import type { PlayerClient } from './controller.js';
import { type CueMember, MAX_CUE_BYTES, planCue } from './cue.js';

export async function prepareCueMedia(
  client: PlayerClient,
  selected: {
    kind: 'asset' | 'source';
    id: string;
    relativePath: string;
    size: number;
    members?: CueMember[];
  },
  limit: number,
  signal?: AbortSignal,
) {
  let entry = selected.relativePath;
  let members = selected.members ?? [];
  if (selected.kind === 'source') {
    if (!client.sourceGroup) throw new Error('Update the server to play CUE/BIN disc groups');
    const group = await client.sourceGroup(selected.id);
    if (group.sourceId !== selected.id || group.error)
      throw new Error('Disc group is incomplete; rescan its folder');
    members = group.files.map((file) => ({
      ...file,
      relativePath: file.relativePath ?? file.name,
    }));
    const anchor = members.find((file) => file.id === selected.id);
    if (!anchor || anchor.size !== selected.size)
      throw new Error('Disc group changed; rescan its folder');
    entry = anchor.relativePath;
  }
  const collect = (id: string, maxBytes: number) =>
    selected.kind === 'source'
      ? client.collectSource(id, { maxBytes, signal })
      : client.collect(id, { maxBytes, signal });
  signal?.throwIfAborted();
  const descriptor = (await collect(selected.id, MAX_CUE_BYTES)).bytes;
  if (descriptor.byteLength !== selected.size)
    throw new Error('CUE descriptor changed; refresh before playing');
  const plan = planCue(descriptor, entry, members, limit);
  const files: { path: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
  for (const file of plan.files) {
    signal?.throwIfAborted();
    const bytes = (await collect(file.id, file.size)).bytes;
    if (bytes.byteLength !== file.size)
      throw new Error('Disc track changed; refresh before playing');
    files.push({ path: file.path, bytes });
  }
  signal?.throwIfAborted();
  return { content: plan.content, files };
}
