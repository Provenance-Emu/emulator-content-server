import '@ecs/web/app.css';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { mount } from 'svelte';
import { get, writable } from 'svelte/store';
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
const trayFailure = writable<string | null>(null);

const cliTools = writable({ busy: false, message: '', failure: false });
const installCliTools =
  native && /Mac/.test(navigator.platform)
    ? async () => {
        if (get(cliTools).busy) return;
        cliTools.set({
          busy: true,
          message: 'Downloading and verifying CLI tools…',
          failure: false,
        });
        try {
          const pathConfigured = await invoke<boolean>('install_cli_tools');
          cliTools.set({
            busy: false,
            message: pathConfigured
              ? 'Installed ecs and ecs-plugins. Open a new Terminal window to use them.'
              : 'Installed ecs and ecs-plugins. Add ~/.local/bin to your shell PATH to use them.',
            failure: false,
          });
        } catch (error) {
          cliTools.set({
            busy: false,
            message: error instanceof Error ? error.message : String(error),
            failure: true,
          });
        }
      }
    : undefined;

mount(Panel, {
  target,
  props: {
    watch,
    service,
    selection,
    trayFailure,
    cliTools,
    installCliTools,
    canOpen: () => void showLibrary(),
    openBrowser: () => void openExternal(watch.interfaceUrl),
  },
});

// Native menu requests must never delay the bundled status window.
if (native) {
  void installTray(watch, service, installCliTools)
    .then(async (update) => {
      refresh = update;
      await update();
    })
    .catch((error: unknown) => {
      trayFailure.set(error instanceof Error ? error.message : String(error));
      const window = getCurrentWindow();
      void window
        .show()
        .then(() => window.setFocus())
        .catch(() => {});
    });
}

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
