import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '@ecs/domain';
import { PLAYER_PACKAGE_LIMIT, parsePlayerPackage } from '@ecs/plugins';
import type { PlayerCatalogEntry } from '@ecs/protocol';
import { readRegular } from './player-assets.js';
import { MAX_PLAYER_PROFILES, MAX_PLAYER_SNAPSHOT_BYTES } from './player-limits.js';

interface LocalPackage {
  entry: PlayerCatalogEntry;
  sha256: string;
}

/** Host-managed packages are offered in Settings but only activated by the server owner. */
export class LocalPlayerCatalog {
  private packages = new Map<string, LocalPackage>();
  private root: string | undefined;

  async initialize(dataDir: string) {
    const root = join(await realpath(dataDir), 'player-packages');
    try {
      if (!(await lstat(root)).isDirectory()) return;
      let examined = 0;
      let budget = MAX_PLAYER_SNAPSHOT_BYTES;
      for await (const file of await opendir(root)) {
        if (++examined > 4096 || this.packages.size >= MAX_PLAYER_PROFILES || budget < 1) break;
        if (!file.isFile() || !/^[a-z0-9][a-z0-9._-]{0,119}\.ecsplayer$/.test(file.name)) continue;
        try {
          const bytes = await readRegular(root, file.name, Math.min(budget, PLAYER_PACKAGE_LIMIT));
          budget -= bytes.length;
          const { manifest, files } = parsePlayerPackage(bytes);
          const player = manifest.player;
          if (
            !player?.web ||
            file.name !== `${manifest.id}.ecsplayer` ||
            !files
              .get(player.web.wasm.file)
              ?.subarray(0, 8)
              .equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
          )
            continue;
          this.packages.set(manifest.id, {
            entry: {
              id: manifest.id,
              name: manifest.name,
              systems: player.systems,
              description: 'Custom browser build supplied by this server.',
              available: true,
              reason: null,
              downloadBytes: bytes.length,
            },
            sha256: createHash('sha256').update(bytes).digest('hex'),
          });
        } catch {
          // A partial or invalid package cannot make the rest of the catalog unavailable.
        }
      }
      this.root = root;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  entries(): PlayerCatalogEntry[] {
    return [...this.packages.values()].map(({ entry }) => entry);
  }

  has(id: string): boolean {
    return this.packages.has(id);
  }

  async read(id: string): Promise<Buffer> {
    const known = this.packages.get(id);
    try {
      if (known && this.root && (await realpath(this.root)) === this.root) {
        const length = known.entry.downloadBytes ?? 0;
        const bytes = await readRegular(this.root, `${id}.ecsplayer`, length);
        if (
          bytes.length === length &&
          createHash('sha256').update(bytes).digest('hex') === known.sha256
        )
          return bytes;
      }
    } catch {
      // Do not expose paths or filesystem errors in the API response.
    }
    throw new DomainError(
      'conflict',
      409,
      'Server emulator package changed. Restart the server to refresh the catalog.',
    );
  }
}
