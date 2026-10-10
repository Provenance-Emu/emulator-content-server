export const ASSET_KINDS = [
  'rom',
  'battery_save',
  'save_state',
  'screenshot',
  'artwork',
  'bios',
  'system_file',
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export const RESTRICTED_ASSET_KINDS: ReadonlySet<AssetKind> = new Set(['bios', 'system_file']);

export function isRestrictedAssetKind(kind: AssetKind): boolean {
  return RESTRICTED_ASSET_KINDS.has(kind);
}

export const LIBRARY_ROLES = ['owner', 'editor', 'reader'] as const;
export type LibraryRole = (typeof LIBRARY_ROLES)[number];

export const ITEM_PERMISSIONS = ['read', 'write', 'admin'] as const;
export type ItemPermission = (typeof ITEM_PERMISSIONS)[number];

export const GUEST_CAPABILITIES = ['read', 'write', 'share_restricted'] as const;
export type GuestCapability = (typeof GUEST_CAPABILITIES)[number];
