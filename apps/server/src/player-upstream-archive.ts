import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DomainError } from '@ecs/domain';
import { readRegular } from './player-assets.js';
import type { TrustedPlayer } from './player-catalog.js';
import {
  catalogJson,
  createPlayerCatalogSnapshot,
  type PlayerCatalogSnapshot,
} from './player-catalog-snapshot.js';
import { upstreamPlayerCatalog } from './player-catalog-upstream.js';
import { buildUpstreamPlayerPackage, validateCatalogPlayerDescriptor } from './player-download.js';
import type { ArchiveExtraction } from './player-upstream-archive-worker.js';

export interface UpstreamArchiveSource {
  url: string;
  sizeBytes: number;
  sha256: string;
  entries: readonly TrustedPlayer[];
}

// These official dated bytes were matched against the existing catalog resource pins.
// Extraction is shipped as 7z-wasm 1.2.0, with its License.txt retained by pnpm deploy.
export const upstreamArchiveSources: readonly UpstreamArchiveSource[] = [
  {
    url: 'https://buildbot.libretro.com/nightly/emscripten/2026-10-31_RetroArch.7z',
    sizeBytes: 774877505,
    sha256: '44ad5820a2b947f1a6f90e17d4decd29e332a748bbcfaa6383be8e8704c633ba',
    entries: upstreamPlayerCatalog.filter(
      (entry) => entry.available && entry.id !== 'org.libretro.pcsx-rearmed',
    ),
  },
  {
    url: 'https://buildbot.libretro.com/nightly/emscripten/2026-11-04_RetroArch.7z',
    sizeBytes: 775282631,
    sha256: 'e22ea52b816e647682c9f488d7288871c2e4bd164a92dd43235b78aee0e7ae2d',
    entries: upstreamPlayerCatalog.filter(
      (entry) => entry.available && entry.id === 'org.libretro.pcsx-rearmed',
    ),
  },
];

const MAX_ARCHIVE_BYTES = 800 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 340 * 1024 * 1024;
const PREPARATION_TIMEOUT = 10 * 60 * 1000;
const EXTRACTION_TIMEOUT = 3 * 60 * 1000;
const inFlight = new Map<string, Promise<void>>();
// One solid-archive operation at a time bounds aggregate disk, memory and CPU use.
let preparationTail: Promise<void> = Promise.resolve();

function archiveError(message: string) {
  return new DomainError('unavailable', 503, message);
}

function matches(entry: TrustedPlayer, known: TrustedPlayer) {
  return (
    entry.available &&
    entry.id === known.id &&
    !!entry.upstream &&
    !!known.upstream &&
    catalogJson(entry.upstream.manifest) === catalogJson(known.upstream.manifest) &&
    catalogJson(
      entry.upstream.resources.map(({ file, sizeBytes, sha256 }) => ({ file, sizeBytes, sha256 })),
    ) ===
      catalogJson(
        known.upstream.resources.map(({ file, sizeBytes, sha256 }) => ({
          file,
          sizeBytes,
          sha256,
        })),
      )
  );
}

function validateArchiveSource(source: UpstreamArchiveSource) {
  const url = new URL(source.url);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'buildbot.libretro.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/nightly\/emscripten\/\d{4}-\d{2}-\d{2}_RetroArch\.7z$/.test(url.pathname) ||
    !Number.isSafeInteger(source.sizeBytes) ||
    source.sizeBytes < 1 ||
    source.sizeBytes > MAX_ARCHIVE_BYTES ||
    !/^[a-f0-9]{64}$/.test(source.sha256)
  )
    throw archiveError('Invalid pinned emulator archive descriptor');
}

async function downloadArchive(source: UpstreamArchiveSource, path: string) {
  validateArchiveSource(source);
  const file = await open(path, 'wx', 0o600);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(
        archiveError(
          'The reviewed emulator archive download timed out. Refresh emulators and retry.',
        ),
      );
    }, PREPARATION_TIMEOUT);
  });
  try {
    const response = await Promise.race([
      fetch(source.url, { redirect: 'error', signal: controller.signal }),
      deadline,
    ]);
    if (!response.ok || !response.body)
      throw archiveError(
        'The reviewed emulator archive is unavailable. Refresh emulators and retry.',
      );
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== source.sizeBytes)
      throw archiveError('The reviewed emulator archive size has changed');
    reader = response.body.getReader();
    const hash = createHash('sha256');
    let received = 0;
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      received += value.byteLength;
      if (received > source.sizeBytes)
        throw archiveError('Emulator archive exceeds its pinned size');
      hash.update(value);
      await Promise.race([file.writeFile(value), deadline]);
    }
    if (received !== source.sizeBytes)
      throw archiveError('The reviewed emulator archive download was incomplete');
    if (hash.digest('hex') !== source.sha256)
      throw archiveError('Emulator archive checksum mismatch');
  } finally {
    clearTimeout(timeout);
    controller.abort();
    // A broken transport may leave cancellation pending forever. It cannot hold preparation open.
    void reader?.cancel().catch(() => {});
    try {
      reader?.releaseLock();
    } catch {
      /* A timed-out read can still be pending. */
    }
    await file.close();
  }
}

async function extractArchive(input: ArchiveExtraction) {
  await new Promise<void>((accept, reject) => {
    const child = fork(
      fileURLToPath(new URL('./player-upstream-archive-worker.js', import.meta.url)),
      {
        execArgv: ['--max-old-space-size=64', '--wasm-max-mem-pages=4096'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, NODE_OPTIONS: '' },
      },
    );
    let successful = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, EXTRACTION_TIMEOUT);
    child.on('message', (message) => {
      successful =
        !!message && typeof message === 'object' && 'ok' in message && message.ok === true;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (successful && code === 0) accept();
      else
        reject(
          archiveError('The reviewed emulator archive could not be extracted within its limits'),
        );
    });
    child.send(input);
  });
}

/** SQLite's OS lease is released on process death, including during a stalled archive download. */
export async function preparationLease(
  root: string,
  name = '.prepare.sqlite',
): Promise<() => void> {
  const path = join(root, name);
  const existing = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existing && !existing.isFile())
    throw archiveError('The emulator recovery lease is not a regular file');
  if (!existing) {
    const file = await open(path, 'wx', 0o600).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw error;
    });
    await file?.close();
  }
  if (!(await lstat(path)).isFile()) throw archiveError('The emulator recovery lease is unsafe');
  await chmod(path, 0o600);
  const database = new DatabaseSync(path);
  const deadline = performance.now() + PREPARATION_TIMEOUT + EXTRACTION_TIMEOUT + 60_000;
  try {
    for (;;) {
      try {
        database.exec('BEGIN EXCLUSIVE');
        return () => {
          try {
            database.exec('ROLLBACK');
          } finally {
            database.close();
          }
        };
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if ((code !== 5 && code !== 6) || performance.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  } catch (error) {
    database.close();
    throw error;
  }
}

export class PlayerUpstreamArchive {
  private root: string;
  constructor(
    directory: string,
    private retain: (
      snapshot: PlayerCatalogSnapshot,
      entry: TrustedPlayer,
      bytes: Buffer,
    ) => Promise<void>,
    private sources: readonly UpstreamArchiveSource[] = upstreamArchiveSources,
  ) {
    sources.forEach((source) => {
      validateArchiveSource(source);
    });
    this.root = join(dirname(resolve(directory)), 'player-upstream-cache');
  }

  private group(source: UpstreamArchiveSource) {
    return join(this.root, source.sha256);
  }

  private receipt(source: UpstreamArchiveSource) {
    return Buffer.from(
      catalogJson({
        archive: source.sha256,
        resources: source.entries.flatMap(
          (entry) =>
            entry.upstream?.resources.map(({ file, sizeBytes, sha256 }) => ({
              file,
              sizeBytes,
              sha256,
            })) ?? [],
        ),
      }),
    );
  }

  private async cached(
    entry: TrustedPlayer,
    source: UpstreamArchiveSource,
  ): Promise<Buffer | null> {
    try {
      const group = this.group(source);
      if (
        !(await lstat(this.root)).isDirectory() ||
        !(await lstat(group)).isDirectory() ||
        !(await lstat(join(group, 'retroarch'))).isDirectory()
      )
        return null;
      const expected = this.receipt(source);
      const receipt = await readRegular(group, 'receipt.json', expected.length);
      if (!receipt.equals(expected)) return null;
      const resources: Buffer[] = [];
      for (const resource of entry.upstream?.resources ?? [])
        resources.push(
          await readRegular(join(group, 'retroarch'), resource.file, resource.sizeBytes),
        );
      return buildUpstreamPlayerPackage(entry, resources);
    } catch {
      return null;
    }
  }

  async recover(entry: TrustedPlayer, snapshot: PlayerCatalogSnapshot): Promise<Buffer | null> {
    const source = this.sources.find((source) =>
      source.entries.some((known) => matches(entry, known)),
    );
    if (!source) return null;
    let bytes = await this.cached(entry, source);
    if (!bytes) {
      const key = `${this.root}:${source.sha256}`;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = preparationTail.then(() => this.prepare(source, entry));
        preparationTail = pending.catch(() => {});
        inFlight.set(key, pending);
        void pending
          .finally(() => {
            if (inFlight.get(key) === pending) inFlight.delete(key);
          })
          .catch(() => {});
      }
      await pending;
      bytes = await this.cached(entry, source);
    }
    if (!bytes) throw archiveError('The reviewed emulator recovery files could not be verified');
    await this.retain(snapshot, entry, bytes).catch(() => {});
    return bytes;
  }

  private async prune(source: UpstreamArchiveSource, required: number) {
    const current = new Set(this.sources.map((source) => source.sha256));
    let used = 0;
    const groups = await readdir(this.root, { withFileTypes: true });
    for (const group of groups) {
      if (!/^[a-f0-9]{64}$/.test(group.name)) continue;
      const path = join(this.root, group.name);
      if (!current.has(group.name) || group.name === source.sha256) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (!group.isDirectory()) throw archiveError('The managed emulator recovery cache is unsafe');
      const files = await readdir(join(path, 'retroarch'));
      if (files.length > 128)
        throw archiveError('Emulator recovery cache exceeds its member limit');
      for (const name of files) {
        const info = await lstat(join(path, 'retroarch', name));
        if (!info.isFile()) throw archiveError('The managed emulator recovery cache is unsafe');
        used += info.size;
      }
    }
    if (used + required > MAX_EXTRACTED_BYTES)
      throw archiveError('The managed emulator recovery cache exceeds its disk budget');
  }

  private async prepare(source: UpstreamArchiveSource, requested: TrustedPlayer) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.root)).isDirectory())
      throw archiveError('A writable emulator recovery cache is required');
    await chmod(this.root, 0o700);
    const release = await preparationLease(this.root);
    let staging: string | null = null;
    try {
      // An extraction child can briefly outlive its parent. Its own OS lease guards cleanup.
      const extractionBarrier = await preparationLease(this.root, '.extract.sqlite');
      extractionBarrier();
      for (const name of await readdir(this.root)) {
        if (/^\.staging-[A-Za-z0-9]+$/.test(name))
          await rm(join(this.root, name), { recursive: true, force: true });
      }
      // Recheck after the cross-process lease. Another server may already have prepared these bytes.
      if (await this.cached(requested, source)) return;
      source.entries.forEach((entry) => {
        validateCatalogPlayerDescriptor(entry);
      });
      const files = source.entries.flatMap((entry) => entry.upstream?.resources ?? []);
      const total = files.reduce((total, file) => total + file.sizeBytes, 0);
      if (
        !files.length ||
        files.length > 128 ||
        new Set(files.map((file) => file.file)).size !== files.length ||
        files.some(
          (file) =>
            !/^[A-Za-z0-9_]+\.(?:js|wasm)$/.test(file.file) ||
            !Number.isSafeInteger(file.sizeBytes) ||
            file.sizeBytes < 1 ||
            file.sizeBytes > 64 * 1024 * 1024,
        ) ||
        total > MAX_EXTRACTED_BYTES
      )
        throw archiveError('Invalid pinned emulator archive member limits');
      await this.prune(source, total);
      staging = await mkdtemp(join(this.root, '.staging-'));
      const archive = join(staging, 'source.7z');
      const output = join(staging, 'output');
      await mkdir(output, { mode: 0o700 });
      await downloadArchive(source, archive);
      await extractArchive({
        archive,
        output,
        files: files.map(({ file, sizeBytes }) => ({ file, sizeBytes })),
      });
      await rm(archive);
      for (const resource of files) {
        const bytes = await readRegular(
          join(output, 'retroarch'),
          resource.file,
          resource.sizeBytes,
        );
        if (
          bytes.length !== resource.sizeBytes ||
          createHash('sha256').update(bytes).digest('hex') !== resource.sha256
        )
          throw archiveError('Emulator archive member checksum mismatch');
      }
      await writeFile(join(output, 'receipt.json'), this.receipt(source), {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(output, this.group(source));
      const snapshot = createPlayerCatalogSnapshot(source.entries);
      for (const entry of source.entries) {
        const bytes = await this.cached(entry, source);
        if (!bytes) throw archiveError('Emulator archive member checksum mismatch');
        await this.retain(snapshot, entry, bytes).catch(() => {});
      }
    } catch (error) {
      if (error instanceof DomainError && error.status === 503) throw error;
      throw archiveError(
        'The reviewed emulator archive cache could not be prepared. Check free disk space and connectivity, then refresh emulators.',
      );
    } finally {
      try {
        if (staging) await rm(staging, { recursive: true, force: true });
      } finally {
        release();
      }
    }
  }
}
