import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import type {
  FolderPurpose,
  FolderSelectionAdapter,
} from '../../../web/src/lib/folder-selection.js';
import { folderName } from '../../../web/src/lib/folder-selection.js';
import type { DesktopContext, DesktopProfile, DesktopSelection } from './application.js';

export type ManagedEndpoint =
  | { available: true; origin: string; verificationId: string }
  | { available: false; reason: string };
export interface NativeFolders {
  managedEndpoint(): Promise<ManagedEndpoint>;
  chooseDirectory(verificationId: string, purpose: FolderPurpose): Promise<string | null>;
  validate(verificationId: string): Promise<boolean>;
}
const RECOVERY =
  'The local service changed or could not be verified. Use local managed service to verify again, or Connect to browse server folders.';
const UNAVAILABLE =
  'Local service verification is unavailable. Browsing folders on the selected server.';
export const nativeFolders: NativeFolders = {
  async managedEndpoint() {
    try {
      if (!('__TAURI_INTERNALS__' in window)) return { available: false, reason: UNAVAILABLE };
      return await invoke<ManagedEndpoint>('managed_endpoint');
    } catch {
      return { available: false, reason: UNAVAILABLE };
    }
  },
  chooseDirectory: (verificationId, purpose) =>
    invoke('choose_managed_directory', { verificationId, purpose }),
  validate: (verificationId) => invoke('validate_managed_selection', { verificationId }),
};
export function managedProfile(
  endpoint: Extract<ManagedEndpoint, { available: true }>,
): DesktopProfile {
  return { origin: endpoint.origin, label: 'Local managed service', profileKey: 'managed-service' };
}

/** Eligibility is explicit and native-derived; loopback text never creates this profile. */
export function createManagedFolderAdapter(
  context: DesktopContext,
  endpoint: ManagedEndpoint | null,
  native: NativeFolders,
  current: () => DesktopContext | null,
): FolderSelectionAdapter | undefined {
  if (
    !endpoint?.available ||
    context.profile.profileKey !== 'managed-service' ||
    context.origin !== endpoint.origin
  )
    return;
  const key = context.key;
  const { origin, verificationId } = endpoint;
  const live = () => current() === context && context.key === key && context.origin === origin;
  const validate = async () => {
    if (!live()) return false;
    let valid = false;
    try {
      valid = await native.validate(verificationId);
    } catch {
      /* IPC failure also invalidates this selection. */
    }
    if (!live()) return false;
    if (!valid) throw new Error(RECOVERY);
    return true;
  };
  return {
    async choose(request) {
      if (request.contextKey !== key || !(await validate())) return null;
      try {
        const path = await native.chooseDirectory(verificationId, request.purpose);
        if (path === null || !live() || !(await validate())) return null;
        return { path, suggestedName: folderName(path), origin, contextKey: key, verificationId };
      } catch {
        throw new Error(RECOVERY);
      }
    },
    async validate(selection) {
      return (
        selection.contextKey === key &&
        selection.origin === origin &&
        selection.verificationId === verificationId &&
        (await validate())
      );
    },
  };
}
export function folderAdapterFor(selection: DesktopSelection, endpoint: ManagedEndpoint | null) {
  const context = get(selection);
  return context
    ? createManagedFolderAdapter(context, endpoint, nativeFolders, () => get(selection))
    : undefined;
}
