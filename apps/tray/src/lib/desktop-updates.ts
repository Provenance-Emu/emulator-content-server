import { writable } from 'svelte/store';

type Build = { sha: string; builtAt: string };
type PublishedBuild = { sha: string; publishedAt: string };
declare const __ECS_DESKTOP_BUILD__: Build | null;

const release = 'https://github.com/Provenance-Emu/emulator-content-server/releases/tag/nightly';
const api =
  'https://api.github.com/repos/Provenance-Emu/emulator-content-server/releases/tags/nightly';

export function desktopUpdate(
  assets: { name?: string; label?: string | null; created_at?: string }[],
  installed: Build,
  assetName: string,
): PublishedBuild | undefined {
  const asset = assets.find((row) => row.name === assetName);
  const sha = / \[build ([0-9a-f]{40})\]$/.exec(asset?.label ?? '')?.[1];
  const date = asset?.created_at;
  return sha && sha !== installed.sha && date && Date.parse(date) > Date.parse(installed.builtAt)
    ? { sha, publishedAt: date }
    : undefined;
}

export function createDesktopUpdates() {
  const installed = __ECS_DESKTOP_BUILD__;
  const agent = navigator.userAgent;
  const asset = agent.includes('Macintosh')
    ? 'Emulation-Server-nightly-macos-arm64.dmg'
    : agent.includes('Windows')
      ? 'Emulation-Server-nightly-windows-x64.msi'
      : 'Emulation-Server-nightly-linux-x64.AppImage';
  const view = writable<{ available?: PublishedBuild; checkedAt?: string; error?: string }>({});
  let active = false;
  let request: AbortController | undefined;
  async function check() {
    if (!installed || request || !active) return;
    request = new AbortController();
    const { signal } = request;
    const timeout = setTimeout(() => request?.abort(), 12_000);
    try {
      const response = await fetch(api, { signal, credentials: 'omit' });
      if (!response.ok) throw new Error('Release request failed');
      const { assets } = await response.json();
      if (!Array.isArray(assets)) throw new Error('Invalid release response');
      if (active)
        view.set({
          available: desktopUpdate(assets, installed, asset),
          checkedAt: new Date().toISOString(),
        });
    } catch {
      if (active)
        view.update((state) => ({
          ...state,
          checkedAt: new Date().toISOString(),
          error: 'Could not check for a desktop app update.',
        }));
    } finally {
      clearTimeout(timeout);
      request = undefined;
    }
  }
  return {
    subscribe: view.subscribe,
    release,
    installed,
    start() {
      if (!installed) return;
      active = true;
      void check();
      const timer = setInterval(() => void check(), 3_600_000);
      return () => {
        active = false;
        clearInterval(timer);
        request?.abort();
      };
    },
  };
}
