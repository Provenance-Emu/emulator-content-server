export const MAX_BUFFERED_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export const BUFFERED_DOWNLOAD_GUIDANCE =
  'This browser can download files up to 256 MB. For larger files, open this library in Chrome or Edge using HTTPS, or localhost on the server computer, and choose a save location.';

/** Bound the native Blob fallback too, including ZIP bodies with no Content-Length. */
export async function boundedDownloadBlob(
  response: Response,
  maxBytes = MAX_BUFFERED_DOWNLOAD_BYTES,
): Promise<Blob> {
  const size = response.headers.get('content-length');
  if (size !== null && /^\d+$/.test(size) && Number(size) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new RangeError(BUFFERED_DOWNLOAD_GUIDANCE);
  }
  if (!response.body) return new Blob();
  let received = 0;
  const bounded = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, output) {
        if (chunk.byteLength > maxBytes - received)
          throw new RangeError(BUFFERED_DOWNLOAD_GUIDANCE);
        received += chunk.byteLength;
        output.enqueue(chunk);
      },
    }),
  );
  return new Response(bounded).blob();
}
