import { skinLimits } from './types.js';
export function pngSize(bytes: Uint8Array) {
  if (
    bytes.length < 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8) !== 13 ||
    String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR'
  )
    throw Error('Invalid PNG artwork');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    width = v.getUint32(16),
    height = v.getUint32(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > skinLimits.pixels)
    throw Error('Artwork pixel limit exceeded');
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = v.getUint32(offset),
      type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (length > bytes.length - offset - 12) throw Error('Truncated PNG artwork');
    if (['acTL', 'fcTL', 'fdAT'].includes(type))
      throw Error('Animated PNG artwork is not supported');
    offset += length + 12;
    if (type === 'IEND') return { width, height };
  }
  throw Error('Truncated PNG artwork');
}
