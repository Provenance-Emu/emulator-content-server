/** PNGs are the only image format accepted from the isolated player. */
export const SCREENSHOT_LIMIT = 8 * 1024 * 1024;
export const PREVIEW_LIMIT = 2 * 1024 * 1024;
export function pngInfo(
  bytes: Uint8Array,
  limit = SCREENSHOT_LIMIT,
): { width: number; height: number } {
  if (bytes.byteLength > limit) throw new Error('Image exceeds the size limit');
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || !signature.every((b, i) => bytes[i] === b))
    throw new Error('Invalid PNG image');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
    throw new Error('Invalid PNG header');
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_777_216)
    throw new Error('Image dimensions exceed the limit');
  let data = false,
    chunks = 0;
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const size = view.getUint32(offset),
      type = view.getUint32(offset + 4);
    if (++chunks > 4096 || size > bytes.length - offset - 12)
      throw new Error('Incomplete PNG image');
    const end = offset + size + 12;
    if (type === 0x49444154 && size > 0) data = true;
    if (type === 0x49454e44) {
      if (size !== 0 || end !== bytes.length || !data) throw new Error('Invalid PNG image');
      return { width, height };
    }
    offset = end;
  }
  throw new Error('Incomplete PNG image');
}
export function pngDataUrl(bytes: Uint8Array): string {
  pngInfo(bytes, PREVIEW_LIMIT);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}
