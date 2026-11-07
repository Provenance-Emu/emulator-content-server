import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '@ecs/domain';
import { PLAYER_PACKAGE_LIMIT } from '@ecs/plugins';
import { readRegular } from './player-assets.js';
import type { TrustedPlayer } from './player-catalog.js';
import {
  catalogJson,
  type PlayerCatalogSnapshot,
  playerCatalogEntryId,
} from './player-catalog-snapshot.js';
import { downloadCatalogPlayer, verifyCatalogPlayerPackage } from './player-download.js';
import {
  PlayerUpstreamArchive,
  type UpstreamArchiveSource,
  upstreamArchiveSources,
} from './player-upstream-archive.js';

const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_CACHE_FILES = 2048;

/** Optional retention: cache failures never make verified online software unavailable. */
export class PlayerPackageCache {
  private inFlight = new Map<string, Promise<Buffer>>();
  private retentionTail: Promise<void> = Promise.resolve();
  private archives: PlayerUpstreamArchive;

  constructor(
    private directory: string,
    private maxBytes = MAX_CACHE_BYTES,
    archiveSources: readonly UpstreamArchiveSource[] = upstreamArchiveSources,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_CACHE_BYTES)
      throw new Error('Invalid player cache size limit');
    this.archives = new PlayerUpstreamArchive(
      directory,
      (snapshot, entry, bytes) =>
        this.retain(snapshot, `player-${playerCatalogEntryId(entry)}.ecsplayer`, bytes),
      archiveSources,
    );
  }

  download(snapshot: PlayerCatalogSnapshot, id: string): Promise<Buffer> {
    const key = `${snapshot.id}:${id}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const result = this.downloadEntry(snapshot, id).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, result);
    return result;
  }

  private async ready(): Promise<boolean> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      return (await lstat(this.directory)).isDirectory();
    } catch {
      return false;
    }
  }

  private async downloadEntry(snapshot: PlayerCatalogSnapshot, id: string): Promise<Buffer> {
    const entry = snapshot.entries.find((entry) => entry.id === id && entry.available);
    if (!entry)
      throw new DomainError('not-found', 404, 'This emulator is not available to install yet');
    const file = `player-${playerCatalogEntryId(entry)}.ecsplayer`;
    const ready = await this.ready();
    if (ready) {
      try {
        const bytes = await readRegular(this.directory, file, PLAYER_PACKAGE_LIMIT);
        verifyCatalogPlayerPackage(entry, bytes);
        await this.retain(snapshot, file, bytes);
        return bytes;
      } catch {
        // Missing, corrupt or unsafe cache entries are never authoritative.
      }
    }
    if (ready) {
      const compatible = await this.compatiblePackage(entry).catch(() => null);
      if (compatible) {
        await this.retain(snapshot, file, compatible);
        return compatible;
      }
    }
    let bytes: Buffer;
    try {
      bytes = await downloadCatalogPlayer(entry);
    } catch (error) {
      const recovered = await this.archives.recover(entry, snapshot);
      if (!recovered) throw error;
      bytes = recovered;
    }
    if (ready) await this.retain(snapshot, file, bytes);
    return bytes;
  }

  private async compatiblePackage(entry: TrustedPlayer): Promise<Buffer | null> {
    let count = 0;
    let used = 0;
    const directory = await opendir(this.directory);
    for await (const item of directory) {
      if (++count > MAX_CACHE_FILES) return null;
      if (!/^player-[a-f0-9]{64}\.ecsplayer$/.test(item.name)) continue;
      try {
        const path = join(this.directory, item.name);
        const stat = await lstat(path);
        used += stat.size;
        if (used > MAX_CACHE_BYTES) return null;
        if (!stat.isFile() || stat.size < 4 || stat.size > PLAYER_PACKAGE_LIMIT) continue;
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        let id: unknown;
        try {
          const prefix = Buffer.alloc(4);
          if ((await handle.read(prefix, 0, 4, 0)).bytesRead !== 4) continue;
          const size = prefix.readUInt32BE(0);
          if (!size || size > 65536 || size + 4 > stat.size) continue;
          const header = Buffer.alloc(size);
          if ((await handle.read(header, 0, size, 4)).bytesRead !== size) continue;
          id = JSON.parse(header.toString()).manifest?.id;
        } finally {
          await handle.close();
        }
        if (id !== entry.id) continue;
        const bytes = await readRegular(this.directory, item.name, PLAYER_PACKAGE_LIMIT);
        verifyCatalogPlayerPackage(entry, bytes);
        return bytes;
      } catch {
        // A matching identifier is only a hint. The complete pinned package must verify.
      }
    }
    return null;
  }

  private retain(snapshot: PlayerCatalogSnapshot, file: string, bytes: Buffer) {
    const result = this.retentionTail.then(() => this.retainEntry(snapshot, file, bytes));
    this.retentionTail = result.catch(() => {});
    return result;
  }

  private async retainEntry(snapshot: PlayerCatalogSnapshot, file: string, bytes: Buffer) {
    const receipt = Buffer.from(catalogJson(snapshot));
    if (receipt.length > MAX_CATALOG_BYTES || !(await this.ready())) return;
    const lock = join(this.directory, '.write-lock');
    try {
      // Other instances/processes may read complete entries but must not race admission.
      // A busy/stale lock simply disables this optional write; it never blocks install.
      await mkdir(lock, { mode: 0o700 });
    } catch {
      return;
    }
    try {
      const additions: [string, Buffer][] = [];
      for (const [name, content] of [
        [`catalog-${snapshot.id}.json`, receipt],
        [file, bytes],
      ] as const) {
        try {
          const existing = await readRegular(this.directory, name, content.length);
          if (!existing.equals(content)) return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
          additions.push([name, content]);
        }
      }
      let used = 0;
      let count = 0;
      const directory = await opendir(this.directory);
      for await (const item of directory) {
        if (item.name === '.write-lock') continue;
        if (++count > MAX_CACHE_FILES) return;
        const metadata = await lstat(join(this.directory, item.name));
        if (!metadata.isFile()) return;
        used += metadata.size;
        if (used > this.maxBytes) return;
      }
      if (
        count + additions.length > MAX_CACHE_FILES ||
        used + additions.reduce((total, [, content]) => total + content.length, 0) > this.maxBytes
      )
        return;
      for (const [name, content] of additions) await this.publish(name, content);
    } catch {
      // Read-only disks, failed writes and races leave online installs usable.
    } finally {
      await rmdir(lock).catch(() => {});
    }
  }

  private async publish(name: string, bytes: Buffer) {
    const temporary = join(this.directory, `.staging-${randomUUID()}`);
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      // A hard link publishes the complete file without replacing any existing name.
      await link(temporary, join(this.directory, name));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
