import { readSkinArchive } from './archive.js';

self.onmessage = async (e: MessageEvent<ArrayBuffer>) => {
  try {
    const pkg = await readSkinArchive(new Uint8Array(e.data), undefined, (n) =>
      self.postMessage({ progress: n }),
    );
    const assets = await Promise.all(
      pkg.assets.map(async (asset) => ({
        ...asset,
        blob: await asset.blob.arrayBuffer(),
      })),
    );
    // Transfer bytes so the page owns artwork backing data after worker termination.
    self.postMessage(
      { pkg: { ...pkg, original: e.data, assets } },
      { transfer: [e.data, ...assets.map((asset) => asset.blob)] },
    );
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Skin import failed' });
  }
};
