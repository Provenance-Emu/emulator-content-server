import '@ecs/web/app.css';
import { invoke } from '@tauri-apps/api/core';
import { mount } from 'svelte';
import { createServiceControl } from './lib/service';
import { insideTauri, installTray } from './lib/tray';
import { ServerWatch } from './lib/watch.svelte';
import Panel from './Panel.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('The page is missing its mount point');

const watch = new ServerWatch();
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
  }
}

mount(Panel, {
  target,
  props: {
    watch,
    service,
    trayFailure,
    canOpen: (url: string) => {
      // Inside the shell the interface belongs in the real browser, where the
      // operator's session and password manager already are. In a plain browser
      // this file is being developed, so a tab is the honest answer.
      if (native) void import('@tauri-apps/plugin-opener').then((opener) => opener.openUrl(url));
      else window.open(url, '_blank');
    },
  },
});

service.subscribe(() => {
  void refresh?.();
});
function check() {
  // Neither an offline remote address nor a slow HTTP request blocks local controls.
  void watch.check().then(() => refresh?.());
  void service.check();
}
check();
setInterval(check, 10_000);
