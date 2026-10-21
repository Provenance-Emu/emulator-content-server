import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openUrl } from '@tauri-apps/plugin-opener';
import { canonicalServerOrigin } from './application';

export async function openExternal(url: string): Promise<void> {
  const parsed = new URL(url);
  const origin = canonicalServerOrigin(parsed.origin);
  if (parsed.username || parsed.password || parsed.origin !== origin)
    throw new Error('Invalid external server URL.');
  if ('__TAURI_INTERNALS__' in window) await openUrl(parsed.href);
  else window.open(parsed.href, '_blank', 'noopener,noreferrer');
}
export async function showLibrary(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) {
    window.open('library.html', '_blank', 'noopener');
    return;
  }
  const library = await WebviewWindow.getByLabel('library');
  if (!library) throw new Error('The bundled library window is unavailable.');
  await library.show();
  await library.setFocus();
}
