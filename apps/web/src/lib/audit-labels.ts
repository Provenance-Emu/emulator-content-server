/** What each recorded action means to the person reading the log. */
const ACTIONS: Record<string, string> = {
  'abort-upload': 'Cancelled an upload',
  'adopt-conflict': 'Chose a preserved save copy',
  'assign-content-root': 'Moved a folder to a library',
  bootstrap: 'Set up the owner account',
  'complete-upload': 'Uploaded a file',
  'create-content-root': 'Added a server folder',
  'create-device-token': 'Connected a device',
  'create-guest-grant': 'Created a guest link',
  'create-item': 'Added a game',
  'create-library': 'Created a library',
  'create-storage-location': 'Added a storage location',
  'create-user': 'Added an account',
  'delete-asset': 'Moved a file to the trash',
  'delete-content-root': 'Removed a server folder',
  'delete-item': 'Moved a game to the trash',
  'delete-storage-location': 'Removed a storage location',
  'link-game-source': 'Joined two copies of a game',
  'local-sign-in': "Signed in from the server's own computer",
  'local-sign-in-failed': "A sign-in from the server's own computer was refused",
  login: 'Signed in',
  'login-failed': 'A sign-in was refused',
  'remove-item-access': "Removed someone's access to a game",
  'remove-member': 'Removed someone from a library',
  'rename-library': 'Renamed a library',
  'revoke-device-token': 'Disconnected a device',
  'revoke-guest-grant': 'Ended a guest link',
  'revoke-token': 'Signed out',
  'revoke-webdav-credential': 'Removed a WebDAV credential',
  'scan-content-root': "Checked a folder's files",
  'set-access': 'Changed who needs to sign in',
  'set-item-access': 'Shared a game with someone',
  'set-member': 'Changed library access',
  'set-password': 'Changed a password',
  'set-write-location': 'Changed where uploads are saved',
  'update-item': "Changed a game's details",
  'update-source-lookup-hints': 'Changed how a game is looked up',
};

/** A sentence for an action. One the page has no words for yet reads as its code, spaced out. */
export function auditLabel(action: string): string {
  return (
    ACTIONS[action] ?? action.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase())
  );
}

/** Refused sign-ins are what someone scanning the log is looking for. */
export function auditNeedsAttention(action: string): boolean {
  return action.endsWith('-failed');
}
