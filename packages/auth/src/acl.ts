import type { AccessRequest, ItemPermission, LibraryRole } from '@ecs/domain';

const ROLE_PERMISSIONS: Record<LibraryRole, readonly ItemPermission[]> = {
  owner: ['read', 'write', 'admin'],
  editor: ['read', 'write'],
  reader: ['read'],
};

function grants(action: ItemPermission, permissions: readonly ItemPermission[]): boolean {
  return permissions.includes(action);
}

export function authorize(request: AccessRequest): boolean {
  if (request.actor.kind === 'guest') {
    if (request.action === 'admin') return false;
    if (request.actor.libraryId !== request.libraryId) return false;
    if (request.actor.itemId && request.itemId && request.actor.itemId !== request.itemId)
      return false;
    if (request.actor.itemId && !request.itemId) return false;
    const capability = request.action === 'write' ? 'write' : 'read';
    if (!request.actor.capabilities.includes(capability)) return false;
    const restricted =
      request.shareable === false ||
      request.assetKind === 'bios' ||
      request.assetKind === 'system_file';
    if (restricted && !request.actor.capabilities.includes('share_restricted')) return false;
    return true;
  }

  // A LAN admission must not inherit the owner's membership, which includes admin.
  if (request.actor.localTrust) return request.actor.scopes.includes(request.action);
  if (!request.actor.scopes.includes(request.action)) return false;
  if (request.actor.isOwner) return true;

  const permissions = new Set<ItemPermission>();
  if (request.membership) {
    for (const permission of ROLE_PERMISSIONS[request.membership]) permissions.add(permission);
  }
  if (request.itemId) {
    for (const permission of request.itemPermissions ?? []) permissions.add(permission);
  }
  if (!request.itemId) {
    return request.membership
      ? grants(request.action, ROLE_PERMISSIONS[request.membership])
      : false;
  }
  return grants(request.action, [...permissions]);
}
