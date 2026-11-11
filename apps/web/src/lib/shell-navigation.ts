export const settingsSections = [
  { id: 'libraries', label: 'Libraries', group: 'Collection' },
  { id: 'scans', label: 'Scans & details', group: 'Collection' },
  { id: 'storage', label: 'Storage', group: 'Collection' },
  { id: 'emulators', label: 'Emulators', group: 'Collection' },
  { id: 'plugins', label: 'Plugins', group: 'Server' },
  { id: 'access', label: 'Access', group: 'Sharing' },
  { id: 'devices', label: 'Devices', group: 'Sharing' },
  { id: 'webdav', label: 'WebDAV', group: 'Sharing' },
  { id: 'activity', label: 'Activity', group: 'Server' },
  { id: 'status', label: 'Server status', group: 'Server' },
  { id: 'updates', label: 'Updates', group: 'Server' },
] as const;

export type SettingsSection = (typeof settingsSections)[number]['id'];
export interface SettingsDestination {
  section: SettingsSection;
  libraryId?: string;
}
export interface ShellLocation {
  libraryId: string;
  rootId: string;
  unassigned: boolean;
  settings: SettingsSection | null;
  settingsLibraryId: string;
}

export function readShellLocation(search: string): ShellLocation {
  const params = new URLSearchParams(search);
  const identifier = (key: string) => {
    const value = params.get(key) ?? '';
    return value.length <= 256 ? value : '';
  };
  const libraryId = identifier('library');
  const unassigned = !libraryId && params.get('unassigned') === '1';
  const settings =
    settingsSections.find((section) => section.id === params.get('settings'))?.id ?? null;
  return {
    libraryId,
    rootId: libraryId || unassigned ? identifier('folder') : '',
    unassigned,
    settings,
    settingsLibraryId: settings ? identifier('settingsLibrary') : '',
  };
}

export function shellLocationSearch(location: ShellLocation): string {
  const params = new URLSearchParams();
  if (location.libraryId) params.set('library', location.libraryId);
  else if (location.unassigned) params.set('unassigned', '1');
  if (location.rootId) params.set('folder', location.rootId);
  if (location.settings) {
    params.set('settings', location.settings);
    if (location.settingsLibraryId) params.set('settingsLibrary', location.settingsLibraryId);
  }
  const search = params.toString();
  return search ? `?${search}` : '';
}
