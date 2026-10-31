import { type SkinPackage, skinLimits } from './types.js';
export async function importSkin(
  file: Blob,
  signal: AbortSignal,
  progress?: (n: number) => void,
): Promise<SkinPackage> {
  if (file.size > skinLimits.archive) throw Error('Archive byte limit exceeded');
  signal.throwIfAborted();
  const buffer = await file.arrayBuffer();
  signal.throwIfAborted();
  if (typeof Worker === 'undefined') {
    const { readSkinArchive } = await import('./archive.js');
    return readSkinArchive(new Uint8Array(buffer), signal, progress);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
    const done = (error?: Error, pkg?: SkinPackage) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else if (pkg) resolve(pkg);
    };
    const abort = () => done(new DOMException('Skin import cancelled', 'AbortError'));
    const timer = setTimeout(() => done(Error('Skin import timed out')), 30000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = (e) =>
      done(
        Error(
          'Skin archive worker failed: ' + String(e.message || 'module load failure').slice(0, 200),
        ),
      );
    worker.onmessage = (e) => {
      if (e.data.error) done(Error(String(e.data.error)));
      else if (e.data.pkg) {
        const pkg = e.data.pkg;
        done(undefined, {
          ...pkg,
          original: new Blob([pkg.original]),
          assets: pkg.assets.map(
            (asset: Omit<SkinPackage['assets'][number], 'blob'> & { blob: ArrayBuffer }) => ({
              ...asset,
              blob: new Blob([asset.blob], { type: asset.mediaType }),
            }),
          ),
        });
      } else progress?.(Number(e.data.progress));
    };
    worker.postMessage(buffer, [buffer]);
  });
}
