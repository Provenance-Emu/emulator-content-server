import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hashToken, issueToken, tokenHashesEqual } from '@ecs/auth';

export const LOCAL_OWNER_KEY_FILE = 'local-owner.key';

/**
 * Proof that a caller can read the server's own data folder, which is what makes someone the
 * person who runs this server. See docs/superpowers/specs/2026-11-20-local-owner-access-design.md.
 */
export interface LocalOwnerKey {
  matches(candidate: string): boolean;
  /** Removes the file if it still holds this run's key. */
  remove(): Promise<void>;
}

/**
 * Writes this run's key for the owner of the data folder only, replacing any earlier one.
 * Only the hash is kept in memory. Returns null on Windows and when the folder cannot take the
 * file, so a server that cannot offer local sign-in still starts and says so in its capabilities.
 */
export async function writeLocalOwnerKey(dataDir: string): Promise<LocalOwnerKey | null> {
  // Windows ignores the file mode, so the file would be as readable as its folder.
  if (process.platform === 'win32') return null;
  const file = join(dataDir, LOCAL_OWNER_KEY_FILE);
  const issued = issueToken();
  try {
    // Never write through a link or into a file someone else prepared.
    await rm(file, { force: true });
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${issued.token}\n`);
    } finally {
      await handle.close();
    }
  } catch {
    await rm(file, { force: true }).catch(() => {});
    return null;
  }
  const hash = issued.hash;
  return {
    matches: (candidate) => tokenHashesEqual(hashToken(candidate), hash),
    async remove() {
      const current = await readFile(file, 'utf8').catch(() => null);
      if (current !== null && tokenHashesEqual(hashToken(current.trim()), hash))
        await rm(file, { force: true }).catch(() => {});
    },
  };
}
