import wasmUrl from 'libarchive-wasm/dist/libarchive.wasm?url';
import { decodeSevenZip } from './seven-zip.js';

self.onmessage = async ({ data }: MessageEvent<Parameters<typeof decodeSevenZip>>) => {
  try {
    const result = await decodeSevenZip(data[0], data[1], data[2], { locateFile: () => wasmUrl });
    self.postMessage({ result }, { transfer: [result.bytes.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Unable to extract 7z.' });
  }
};
