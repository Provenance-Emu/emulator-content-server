import type { ManifestFile } from '@ecs/client';
import { PREVIEW_LIMIT } from './images.js';
import type { BrowserCore } from './runtime.js';

const PREFIX = 'browser-states/';
const SNAPSHOT =
  /^browser-states\/v1\/([a-f0-9]{64})\/([a-f0-9]{64})\/(\d{13})-([a-f0-9]{32})\.state(?:\.conflict-[a-f0-9]{8})?$/;
export function captureKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export function statePath(core: BrowserCore): string {
  if (![core.loader.sha256, core.wasm.sha256].every((hash) => /^[a-f0-9]{64}$/.test(hash)))
    throw new Error('Invalid emulator build identity');
  return `${PREFIX}v1/${core.loader.sha256}/${core.wasm.sha256}/${Date.now()}-${captureKey()}.state`;
}
export function stateCompatibility(
  path: string,
  core: BrowserCore,
): 'compatible' | 'incompatible' | 'unknown' {
  if (!path.startsWith(PREFIX)) return 'unknown';
  const match = SNAPSHOT.exec(path);
  return match?.[1] === core.loader.sha256 && match[2] === core.wasm.sha256
    ? 'compatible'
    : 'incompatible';
}
export function stateTimestamp(path: string): number | null {
  const match = SNAPSHOT.exec(path);
  return match ? Number(match[3]) : null;
}
export function statePreview(files: ManifestFile[], path: string): ManifestFile | undefined {
  if (!SNAPSHOT.test(path)) return;
  return files.find(
    (file) =>
      file.kind === 'screenshot' &&
      file.relativePath === `${path}.png` &&
      file.size > 0 &&
      file.size <= PREVIEW_LIMIT,
  );
}
