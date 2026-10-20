import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DomainError, type VirtualArtifactBundle, type VirtualEntry } from '@ecs/domain';
import { CHD_VERSION, checkDeadline } from './chd.js';
import type { VirtualProviderRegistry } from './virtual.js';

interface Flight {
  controller: AbortController;
  promise: Promise<VirtualArtifactBundle>;
  waiters: number;
}
const flights = new WeakMap<VirtualProviderRegistry, Map<string, Flight>>();

export async function chdHash(
  file: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  checkDeadline(deadline, signal);
  const stream = createReadStream(file);
  const abort = () =>
    stream.destroy(new DomainError('archive-rejected', 422, 'CHD operation cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) {
      checkDeadline(deadline, signal);
      size += chunk.length;
      hash.update(chunk);
    }
    checkDeadline(deadline, signal);
    return { size, sha256: hash.digest('hex') };
  } finally {
    signal?.removeEventListener('abort', abort);
    stream.destroy();
  }
}

async function validate(
  directory: string,
  entries: VirtualEntry[],
  deadline: number,
  signal: AbortSignal,
): Promise<VirtualArtifactBundle | null> {
  try {
    checkDeadline(deadline, signal);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    const manifestPath = join(directory, 'manifest.json');
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 65536)
      return null;
    const manifest: VirtualArtifactBundle = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
      manifest.version !== CHD_VERSION ||
      !Array.isArray(manifest.files) ||
      manifest.files.length !== entries.length
    )
      return null;
    const names = await readdir(directory);
    if (
      names.length !== entries.length + 1 ||
      names.some(
        (name) => name !== 'manifest.json' && !entries.some((entry) => entry.path === name),
      )
    )
      return null;
    for (const [index, entry] of entries.entries()) {
      checkDeadline(deadline, signal);
      const file = manifest.files[index];
      if (
        !file ||
        file.entryId !== entry.entryId ||
        file.path !== entry.path ||
        file.size !== entry.uncompressedSize ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      )
        return null;
      const path = join(directory, entry.path);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) return null;
      const actual = await chdHash(path, deadline, signal);
      if (actual.size !== file.size || actual.sha256 !== file.sha256) return null;
    }
    return manifest;
  } catch (error) {
    checkDeadline(deadline, signal);
    if (error instanceof DomainError) throw error;
    return null;
  }
}

// mkdir is an atomic cross-process claim. The owner holds this lock from
// revalidation through repair and publication; a stale pre-lock observation can
// never authorize deleting a later winner. Never reclaim another owner's lock
// on a timer: a paused writer could still resume. Crash leftovers require an
// operator to stop all writers before removing the abandoned lock directory.
async function acquireGroupLock(
  directory: string,
  deadline: number,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const lock = `${directory}.lock`;
  for (;;) {
    checkDeadline(deadline, signal);
    try {
      await mkdir(lock, { mode: 0o700 });
      return () => rmdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

// Only the exclusive group-lock owner may repair an invalid final directory.
async function discardInvalid(directory: string): Promise<void> {
  const discarded = `${directory}.${randomUUID()}.invalid`;
  try {
    await rename(directory, discarded);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await rm(discarded, { recursive: true, force: true });
}

export async function openChdBundle(
  root: string,
  outerSha256: string,
  registry: VirtualProviderRegistry,
  format: string,
  input: string,
  bundleId: string,
  selected: VirtualEntry,
  signal?: AbortSignal,
  deadline = performance.now() + registry.quota.timeoutMs,
): Promise<{ path: string; size: number }> {
  // Group identity deliberately includes the representation version. A new CUE
  // normalization cannot reuse an older representation's artifacts.
  const key = createHash('sha256')
    .update(JSON.stringify([outerSha256, format, CHD_VERSION, bundleId]))
    .digest('hex');
  const directory = join(root, 'virtual-cache', outerSha256, 'bundles', key);
  let map = flights.get(registry);
  if (!map) {
    map = new Map();
    flights.set(registry, map);
  }
  let flight = map.get(key);
  if (!flight) {
    const controller = new AbortController();
    const operationSignal = AbortSignal.any([controller.signal, registry.signal]);
    const timeout = setTimeout(() => controller.abort(), Math.max(0, deadline - performance.now()));
    const promise = registry.trackBundle(
      (async () => {
        const layout = await registry.inspect(input);
        if (!layout || layout.format !== format)
          throw new DomainError('unsupported-entry', 422, 'CHD bundle is unavailable');
        checkDeadline(deadline, operationSignal);
        const cached = await validate(directory, layout.entries, deadline, operationSignal);
        if (cached) return cached;
        await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
        const release = await acquireGroupLock(directory, deadline, operationSignal);
        try {
          const winner = await validate(directory, layout.entries, deadline, operationSignal);
          if (winner) return winner;
          await discardInvalid(directory);
          const staging = await mkdtemp(`${directory}.partial-`);
          try {
            const bundle = await registry.materializeBundle(
              format,
              input,
              bundleId,
              staging,
              operationSignal,
            );
            checkDeadline(deadline, operationSignal);
            await writeFile(join(staging, 'manifest.json'), JSON.stringify(bundle), {
              flag: 'wx',
              mode: 0o600,
            });
            const verified = await validate(staging, layout.entries, deadline, operationSignal);
            if (!verified)
              throw new DomainError('archive-rejected', 422, 'Invalid CHD artifact bundle');
            checkDeadline(deadline, operationSignal);
            await rename(staging, directory);
            return verified;
          } finally {
            await rm(staging, { recursive: true, force: true });
          }
        } finally {
          await release();
        }
      })().finally(() => {
        clearTimeout(timeout);
        if (map?.get(key)?.controller === controller) map.delete(key);
      }),
    );
    flight = { controller, promise, waiters: 0 };
    map.set(key, flight);
  }
  const joined = flight;
  joined.waiters += 1;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DomainError('archive-rejected', 422, 'CHD operation cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    const bundle = await Promise.race([joined.promise, cancelled]);
    const file = bundle.files.find(
      (file) =>
        file.entryId === selected.entryId &&
        file.path === selected.path &&
        file.size === selected.uncompressedSize,
    );
    if (!file)
      throw new DomainError('archive-rejected', 422, 'CHD artifact is absent from its bundle');
    return { path: join(directory, file.path), size: file.size };
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    joined.waiters -= 1;
    if (joined.waiters === 0 && map.get(key) === joined) {
      joined.controller.abort();
      await joined.promise.catch(() => {});
    }
  }
}
