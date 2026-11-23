/** Redraws one picture at a time, away from the thread that answers requests. */
import { parentPort } from 'node:worker_threads';
import photon from '@silvia-odwyer/photon-node';

export interface ThumbnailRequest {
  id: number;
  bytes: Uint8Array;
  width: number;
}
export type ThumbnailReply =
  | { id: number; bytes: Uint8Array; contentType: 'image/jpeg' | 'image/webp' }
  | { id: number; bytes: null; broken?: true };

let broken = false;
parentPort?.on('message', (request: ThumbnailRequest) => {
  if (broken) return;
  let picture: InstanceType<typeof photon.PhotonImage> | null = null;
  let small: InstanceType<typeof photon.PhotonImage> | null = null;
  try {
    picture = photon.PhotonImage.new_from_byteslice(request.bytes);
    const width = picture.get_width();
    const height = picture.get_height();
    if (width <= request.width) {
      parentPort?.postMessage({ id: request.id, bytes: null } satisfies ThumbnailReply);
      return;
    }
    small = photon.resize(
      picture,
      request.width,
      Math.max(1, Math.round((height * request.width) / width)),
      photon.SamplingFilter.Lanczos3,
    );
    // JPEG has no transparency; a cut-out cover keeps it as lossless WebP.
    const pixels = small.get_raw_pixels();
    let opaque = true;
    for (let index = 3; index < pixels.length; index += 4)
      if (pixels[index] !== 255) {
        opaque = false;
        break;
      }
    const bytes = opaque ? small.get_bytes_jpeg(82) : small.get_bytes_webp();
    parentPort?.postMessage(
      {
        id: request.id,
        bytes,
        contentType: opaque ? 'image/jpeg' : 'image/webp',
      } satisfies ThumbnailReply,
      [bytes.buffer as ArrayBuffer],
    );
  } catch {
    // The decoder stops on a picture it cannot read. Its memory is not trusted afterwards, so
    // this worker draws nothing more and the server starts another.
    broken = true;
    parentPort?.postMessage({ id: request.id, bytes: null, broken: true } satisfies ThumbnailReply);
  } finally {
    picture?.free();
    small?.free();
  }
});
