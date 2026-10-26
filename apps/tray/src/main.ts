import '@ecs/web/app.css';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { mount } from 'svelte';
import { createDesktopSelection } from './lib/application';
import { createServiceControl } from './lib/service';
import { insideTauri, installTray } from './lib/tray';
import { ServerWatch } from './lib/watch.svelte';
import { openExternal, showLibrary } from './lib/windows';
import Panel from './Panel.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('The page is missing its mount point');

const selection = createDesktopSelection({ openExternal });
const watch = new ServerWatch(selection);
const native = insideTauri();
const service = createServiceControl(
  native ? (command) => invoke<string>(command) : null,
  async () => {
    await watch.check();
  },
);

// A browser cannot own a menu bar, so the tray is only built inside the shell.
// The window still works without one, which is what makes this developable.
let refresh: (() => Promise<void>) | null = null;
let trayFailure: string | null = null;
if (native) {
  try {
    refresh = await installTray(watch, service);
  } catch (error) {
    // Without this the menu would simply be absent and nothing would say why,
    // which is the worst way for a menu-bar application to fail.
    trayFailure = error instanceof Error ? error.message : String(error);
    // The Rust startup menu remains usable; surface the failure instead of
    // leaving its explanation in an inaccessible hidden status window.
    const window = getCurrentWindow();
    await window
      .show()
      .then(() => window.setFocus())
      .catch(() => {});
  }
}

mount(Panel, {
  target,
  props: {
    watch,
    service,
    trayFailure,
    canOpen: () => void showLibrary(),
    openBrowser: () => void openExternal(watch.interfaceUrl),
  },
});

const unsubscribeService = service.subscribe(() => {
  void refresh?.();
});
function check() {
  // Neither an offline remote address nor a slow HTTP request blocks local controls.
  void watch.check().then(() => refresh?.());
  void service.check();
}
check();
const timer = setInterval(check, 10_000);
window.addEventListener(
  'pagehide',
  () => {
    clearInterval(timer);
    unsubscribeService();
    watch.dispose();
    selection.dispose();
  },
  { once: true },
);
