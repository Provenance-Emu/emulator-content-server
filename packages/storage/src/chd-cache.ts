import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, createReadStream } from 'node:fs';
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

interface GroupSnapshot {
  directory: string;
  node: string;
  files: string[];
}
interface VerifiedGroup {
  bundle: VirtualArtifactBundle;
  entries: string;
  snapshot: GroupSnapshot;
}
// Registry lifetime bounds ownership; the LRU also bounds long-lived servers.
const verifiedGroups = new WeakMap<VirtualProviderRegistry, Map<string, VerifiedGroup>>();
const MAX_VERIFIED_GROUPS = 128;

function identity(info: BigIntStats): string {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

async function snapshot(
  directory: string,
  entries: VirtualEntry[],
  deadline: number,
  signal: AbortSignal,
): Promise<GroupSnapshot | null> {
  checkDeadline(deadline, signal);
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) return null;
  const names = await readdir(directory);
  if (
    names.length !== entries.length + 1 ||
    names.some((name) => name !== 'manifest.json' && !entries.some((entry) => entry.path === name))
  )
    return null;
  const files: string[] = [];
  for (const [name, size] of [
    ['manifest.json', undefined],
    ...entries.map((entry) => [entry.path, entry.uncompressedSize] as const),
  ] as const) {
    checkDeadline(deadline, signal);
    const file = await lstat(join(directory, name), { bigint: true });
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      (size === undefined ? file.size > 65536n : file.size !== BigInt(size))
    )
      return null;
    files.push(identity(file));
  }
  checkDeadline(deadline, signal);
  return { directory: identity(info), node: `${info.dev}:${info.ino}`, files };
}

function sameFiles(left: GroupSnapshot, right: GroupSnapshot): boolean {
  return (
    left.files.length === right.files.length &&
    left.files.every((file, i) => file === right.files[i])
  );
}

function remember(
  groups: Map<string, VerifiedGroup>,
  directory: string,
  group: VerifiedGroup,
): void {
  groups.delete(directory);
  groups.set(directory, group);
  const oldest = groups.keys().next().value;
  if (groups.size > MAX_VERIFIED_GROUPS && oldest !== undefined) groups.delete(oldest);
}

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
  groups?: Map<string, VerifiedGroup>,
): Promise<VerifiedGroup | null> {
  try {
    const before = await snapshot(directory, entries, deadline, signal);
    const signature = JSON.stringify(
      entries.map((entry) => [entry.entryId, entry.path, entry.uncompressedSize]),
    );
    const cached = groups?.get(directory);
    groups?.delete(directory);
    if (!before) return null;
    if (
      groups &&
      cached &&
      cached.entries === signature &&
      cached.snapshot.directory === before.directory &&
      sameFiles(cached.snapshot, before)
    ) {
      checkDeadline(deadline, signal);
      remember(groups, directory, cached);
      return cached;
    }
    const manifest: VirtualArtifactBundle = JSON.parse(
      await readFile(join(directory, 'manifest.json'), 'utf8'),
    );
    if (
      manifest.version !== CHD_VERSION ||
      !Array.isArray(manifest.files) ||
      manifest.files.length !== entries.length
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
      const actual = await chdHash(join(directory, entry.path), deadline, signal);
      if (actual.size !== file.size || actual.sha256 !== file.sha256) return null;
    }
    // Never associate a successful hash with metadata from a concurrent edit.
    const after = await snapshot(directory, entries, deadline, signal);
    if (!after || before.directory !== after.directory || !sameFiles(before, after)) return null;
    const verified = { bundle: manifest, entries: signature, snapshot: after };
    if (groups) remember(groups, directory, verified);
    return verified;
  } catch (error) {
    groups?.delete(directory);
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
  const groups = verifiedGroups.get(registry) ?? new Map<string, VerifiedGroup>();
  if (!verifiedGroups.has(registry)) {
    verifiedGroups.set(registry, groups);
    registry.signal.addEventListener('abort', () => groups.clear(), { once: true });
  }
  checkDeadline(deadline, signal);
  checkDeadline(deadline, registry.signal);
  let flight = map.get(key);
  if (flight?.controller.signal.aborted) {
    // The last waiter already cancelled this job. Join its staging/lock cleanup
    // before replacing it; a new caller must not inherit that cancellation.
    await flight.promise.catch(() => {});
    checkDeadline(deadline, signal);
    checkDeadline(deadline, registry.signal);
    return openChdBundle(
      root,
      outerSha256,
      registry,
      format,
      input,
      bundleId,
      selected,
      signal,
      deadline,
    );
  }
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
        const cached = await validate(directory, layout.entries, deadline, operationSignal, groups);
        if (cached) return cached.bundle;
        await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
        const release = await acquireGroupLock(directory, deadline, operationSignal);
        try {
          const winner = await validate(
            directory,
            layout.entries,
            deadline,
            operationSignal,
            groups,
          );
          if (winner) return winner.bundle;
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
            const published = await snapshot(directory, layout.entries, deadline, operationSignal);
            // Rename changes directory timestamps. Reuse publication hashes only
            // when the directory inode and every verified file are unchanged.
            if (
              published &&
              published.node === verified.snapshot.node &&
              sameFiles(published, verified.snapshot)
            )
              remember(groups, directory, { ...verified, snapshot: published });
            checkDeadline(deadline, operationSignal);
            return verified.bundle;
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
