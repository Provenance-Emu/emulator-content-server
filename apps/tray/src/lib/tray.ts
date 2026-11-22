import { invoke } from '@tauri-apps/api/core';
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { exit } from '@tauri-apps/plugin-process';
import { get } from 'svelte/store';
import {
  canRepair,
  canRestart,
  canStart,
  canStop,
  type ServiceControl,
  serviceSummary,
} from './service';
import type { ServerWatch } from './watch.svelte';
import { openExternal, showLibrary } from './windows';

/** True when this page is running inside the native shell rather than a browser. */
export function insideTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

/**
 * Puts the status in the menu bar.
 *
 * Live status items read the same client and state as the status window.
 * The native shell attaches the Apps group. The icon comes from the
 * configuration instead, because a menu-bar image has to be a template that
 * follows the system appearance, which is not something to decide at runtime.
 *
 * The returned function is called after each poll: a menu item is a native
 * object that has to be told its new text, and does not re-render on its own.
 */
export async function installTray(
  watch: ServerWatch,
  service: ServiceControl,
  installCliTools?: () => Promise<void>,
): Promise<() => Promise<void>> {
  const window = getCurrentWindow();
  const status = await MenuItem.new({ text: watch.summary, enabled: false });
  const openInterface = await MenuItem.new({
    text: 'Open interface',
    action: () => void showLibrary(),
  });
  const openBrowser = await MenuItem.new({
    text: 'Open in browser',
    enabled: !!watch.origin,
    action: () => void openExternal(watch.interfaceUrl),
  });
  const showWindow = await MenuItem.new({
    text: 'Status and settings',
    action: () => void window.show().then(() => window.setFocus()),
  });
  const localStatus = await MenuItem.new({ text: serviceSummary(get(service)), enabled: false });
  const operate = async (action: 'start' | 'stop' | 'restart' | 'repair') => {
    await service[action]();
    if (get(service).failure) await window.show().then(() => window.setFocus());
  };
  const startService = await MenuItem.new({
    text: 'Start local service',
    enabled: canStart(get(service)),
    action: () => void operate('start'),
  });
  const stopService = await MenuItem.new({
    text: 'Stop local service',
    enabled: canStop(get(service)),
    action: () => void operate('stop'),
  });
  const restartService = await MenuItem.new({
    text: 'Restart local service',
    enabled: canRestart(get(service)),
    action: () => void operate('restart'),
  });
  // Shown enabled only when the service cannot run as it is; the status window has it always.
  const needsRepair = () => canRepair(get(service)) && get(service).state === 'broken';
  const repairService = await MenuItem.new({
    text: 'Repair local service',
    enabled: needsRepair(),
    action: () => void operate('repair'),
  });
  const serviceDetails = await MenuItem.new({
    text: get(service).state === 'absent' ? 'Set up a server…' : 'Local service details…',
    action: () => {
      if (get(service).state === 'absent') void showLibrary();
      else void window.show().then(() => window.setFocus());
    },
  });
  const cliItems = installCliTools
    ? [
        await MenuItem.new({
          text: 'Install CLI Tools…',
          action: () => {
            void window
              .show()
              .then(() => window.setFocus())
              .catch(() => {});
            void installCliTools();
          },
        }),
      ]
    : [];
  const quit = await MenuItem.new({ text: 'Quit', action: () => void exit(0) });
  const menu = await Menu.new({
    items: [
      status,
      await PredefinedMenuItem.new({ item: 'Separator' }),
      openInterface,
      openBrowser,
      showWindow,
      await PredefinedMenuItem.new({ item: 'Separator' }),
      localStatus,
      startService,
      restartService,
      stopService,
      repairService,
      serviceDetails,
      ...cliItems,
      await PredefinedMenuItem.new({ item: 'Separator' }),
      quit,
    ],
  });
  await invoke('install_live_tray_menu', { menuId: menu.rid });
  return async () => {
    await status.setText(watch.summary);
    const local = get(service);
    await localStatus.setText(serviceSummary(local));
    await serviceDetails.setText(
      local.state === 'absent' ? 'Set up a server…' : 'Local service details…',
    );
    await startService.setEnabled(canStart(local));
    await stopService.setEnabled(canStop(local));
    await restartService.setEnabled(canRestart(local));
    await repairService.setEnabled(needsRepair());
    // The tooltip is the only place with room for the time of the last check.
    await invoke('set_live_tray_tooltip', {
      tooltip: watch.checkedAt ? `${watch.summary}, checked ${watch.checkedAt}` : watch.summary,
    });
    await openBrowser.setEnabled(!!watch.origin);
  };
}
