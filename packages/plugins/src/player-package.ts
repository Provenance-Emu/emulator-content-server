import { createHash } from 'node:crypto';
import { parseManifest } from './manifest.js';

export const PLAYER_PACKAGE_LIMIT = 104 * 1024 * 1024 + 64 * 1024 + 4;
/** Length-prefixed UTF-8 manifest/file table followed by exact raw resource bytes. No extraction. */
export function parsePlayerPackage(bytes: Uint8Array) {
  if (bytes.byteLength < 4 || bytes.byteLength > PLAYER_PACKAGE_LIMIT)
    throw new Error('Invalid player package size');
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = buffer.readUInt32BE(0);
  if (!length || length > 64 * 1024 || length + 4 > buffer.length)
    throw new Error('Invalid player package header');
  const header = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(4, 4 + length)),
  );
  const manifest = parseManifest(header.manifest);
  const web = manifest.player?.web;
  if (manifest.kind !== 'player' || manifest.entry || !web)
    throw new Error('Browser player manifest required');
  const specs = [web.loader, web.wasm, ...web.assets];
  if (!Array.isArray(header.files) || header.files.length !== specs.length)
    throw new Error('Invalid player file table');
  const files = new Map<string, Buffer>();
  let offset = 4 + length,
    assetBytes = 0;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i],
      file = header.files[i];
    if (
      !spec ||
      file?.name !== spec.file ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      files.has(file.name)
    )
      throw new Error('Invalid player resource');
    const cap = i === 0 ? 8 * 1024 * 1024 : i === 1 ? 64 * 1024 * 1024 : 32 * 1024 * 1024;
    if (file.size > cap || offset + file.size > buffer.length)
      throw new Error('Oversized or incomplete player resource');
    if (i > 1) assetBytes += file.size;
    if (assetBytes > 32 * 1024 * 1024) throw new Error('Player assets exceed limit');
    const content = buffer.subarray(offset, offset + file.size);
    if (createHash('sha256').update(content).digest('hex') !== spec.sha256)
      throw new Error('Player resource checksum mismatch');
    files.set(spec.file, content);
    offset += file.size;
  }
  if (offset !== buffer.length) throw new Error('Unexpected player package bytes');
  return { manifest, files };
}
