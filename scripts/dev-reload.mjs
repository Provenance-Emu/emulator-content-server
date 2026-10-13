import { sep } from 'node:path';

/**
 * A compiled server file should restart the process. The web build should not:
 * the server reads those assets off disk, and restarting would drop every
 * connection for a stylesheet change.
 */
export function shouldRestart(path) {
  const relative = path.split(sep).join('/');
  if (!relative.endsWith('.js')) return false;
  if (!relative.includes('/dist/')) return false;
  if (relative.startsWith('apps/web/') || relative.startsWith('apps/tray/')) return false;
  return (
    relative.startsWith('packages/') ||
    relative.startsWith('apps/server/') ||
    relative.startsWith('apps/cli/')
  );
}
