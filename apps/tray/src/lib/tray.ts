import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { TrayIcon } from '@tauri-apps/api/tray';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { exit } from '@tauri-apps/plugin-process';
import { get } from 'svelte/store';
import { canStart, canStop, type ServiceControl, serviceSummary } from './service';
import type { ServerWatch } from './watch.svelte';
import { openExternal, showLibrary } from './windows';

const TRAY_ID = 'status';

/** True when this page is running inside the native shell rather than a browser. */
export function insideTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

/**
 * Puts the status in the menu bar.
 *
 * The menu is built here rather than in Rust so the dropdown and the status
 * window read the same client and the same state. The icon comes from the
 * configuration instead, because a menu-bar image has to be a template that
 * follows the system appearance, which is not something to decide at runtime.
 *
 * The returned function is called after each poll: a menu item is a native
 * object that has to be told its new text, and does not re-render on its own.
 */
export async function installTray(
  watch: ServerWatch,
  service: ServiceControl,
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
  const operate = async (action: 'start' | 'stop') => {
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
  const serviceDetails = await MenuItem.new({
    text:
      get(service).state === 'absent' ? 'Install service: instructions…' : 'Local service details…',
    action: () => void window.show().then(() => window.setFocus()),
  });
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
      stopService,
      serviceDetails,
      await PredefinedMenuItem.new({ item: 'Separator' }),
      quit,
    ],
  });
  const tray = (await TrayIcon.getById(TRAY_ID)) ?? (await TrayIcon.new({ id: TRAY_ID, menu }));
  await tray.setMenu(menu);
  await tray.setShowMenuOnLeftClick(true);
  return async () => {
    await status.setText(watch.summary);
    const local = get(service);
    await localStatus.setText(serviceSummary(local));
    await serviceDetails.setText(
      local.state === 'absent' ? 'Install service: instructions…' : 'Local service details…',
    );
    await startService.setEnabled(canStart(local));
    await stopService.setEnabled(canStop(local));
    // The tooltip is the only place with room for the time of the last check.
    await tray.setTooltip(
      watch.checkedAt ? `${watch.summary}, checked ${watch.checkedAt}` : watch.summary,
    );
    await openBrowser.setEnabled(!!watch.origin);
  };
}
