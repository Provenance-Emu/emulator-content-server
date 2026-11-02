/** Bounded official upstream downloads; no content or firmware is fetched here. */
import { createHash } from 'node:crypto';
export const LIBRETRO_WEB = 'https://web.libretro.com';
export const LIBRETRO_LIMITS = Object.freeze({ js: 8 * 1024 * 1024, wasm: 64 * 1024 * 1024 });
export function parseCoreList(text) {
  return [...new Set([...text.matchAll(/^\s*"([A-Za-z0-9_]+)"\s*:/gm)].map((match) => match[1]))];
}
export async function boundedDownload(url, cap, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > cap) {
    await response.body?.cancel();
    throw new Error('Download exceeds byte cap');
  }
  if (!response.body) throw new Error('Missing download stream');
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel();
        throw new Error('Download exceeds byte cap');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    lastModified: response.headers.get('last-modified'),
  };
}
export function parseCoreInfo(text) {
  return Object.fromEntries(
    [...text.matchAll(/^([a-z0-9_]+)\s*=\s*"([^"\r\n]*)"/gm)].map((match) => [match[1], match[2]]),
  );
}
