/// <reference path="./worker-url.d.ts" />
import { pngSize } from './png.js';
import { type SkinAsset, skinLimits } from './types.js';
export interface RenderedAsset {
  url: string;
  width: number;
  height: number;
  release(): void;
}
export async function renderSkinAsset(
  asset: SkinAsset,
  signal: AbortSignal,
): Promise<RenderedAsset> {
  signal.throwIfAborted();
  if (asset.blob.size > skinLimits.asset) throw Error('Artwork byte limit exceeded');
  const bytes = new Uint8Array(await asset.blob.arrayBuffer());
  signal.throwIfAborted();
  if (asset.mediaType === 'image/png') {
    const size = pngSize(bytes),
      url = URL.createObjectURL(asset.blob);
    try {
      await new Promise<void>((resolve, reject) => {
        const img = new Image(),
          abort = () => {
            img.src = '';
            cleanup();
            reject(new DOMException('Artwork cancelled', 'AbortError'));
          };
        const cleanup = () => {
          signal.removeEventListener('abort', abort);
          img.onload = null;
          img.onerror = null;
        };
        img.onload = () => {
          const valid = img.naturalWidth === size.width && img.naturalHeight === size.height;
          cleanup();
          valid ? resolve() : reject(Error('PNG dimensions changed while decoding'));
        };
        img.onerror = () => {
          cleanup();
          reject(Error('PNG artwork could not be decoded'));
        };
        signal.addEventListener('abort', abort, { once: true });
        img.src = url;
      });
      signal.throwIfAborted();
      return { url, ...size, release: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  signal.throwIfAborted();
  const task = pdfjs.getDocument({
    data: bytes,
    maxImageSize: skinLimits.pixels,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableXfa: false,
    stopAtErrors: true,
  });
  const abort = () => {
    void task.destroy();
  };
  signal.addEventListener('abort', abort, { once: true });
  let canvas: HTMLCanvasElement | undefined;
  try {
    const pdf = await task.promise;
    signal.throwIfAborted();
    if (pdf.numPages !== 1) throw Error('Skin artwork must be a single-page PDF');
    const page = await pdf.getPage(1),
      base = page.getViewport({ scale: 1 });
    if (
      base.width <= 0 ||
      base.height <= 0 ||
      base.width > 8192 ||
      base.height > 8192 ||
      base.width * base.height > skinLimits.pixels
    )
      throw Error('PDF pixel limit exceeded');
    const scale = Math.min(
        2,
        8192 / base.width,
        8192 / base.height,
        Math.sqrt(skinLimits.pixels / (base.width * base.height)),
      ),
      viewport = page.getViewport({ scale });
    canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw Error('Artwork canvas is unavailable');
    await page.render({ canvas, canvasContext: context, viewport, background: 'rgba(0,0,0,0)' })
      .promise;
    signal.throwIfAborted();
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas!.toBlob(
        (b) => (b ? resolve(b) : reject(Error('PDF artwork conversion failed'))),
        'image/png',
      ),
    );
    signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    return {
      url,
      width: canvas.width,
      height: canvas.height,
      release: () => URL.revokeObjectURL(url),
    };
  } finally {
    signal.removeEventListener('abort', abort);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    await task.destroy();
  }
}
