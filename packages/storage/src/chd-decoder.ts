import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { DomainError, type VirtualArtifactBundle, type VirtualContentProvider } from '@ecs/domain';
import { CHD_BUNDLE_ID, CHD_VERSION, checkDeadline, inspectChd, rejectChd } from './chd.js';
import { chdHash } from './chd-cache.js';

export interface DecoderProcess {
  stdout: Readable;
  stderr: Readable;
  exited: Promise<{ code: number | null; signal?: string | null }>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}
export type ProcessRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; shell: false; stdio: readonly string[]; windowsHide: boolean },
) => DecoderProcess;
export interface ChdProviderOptions {
  runner?: ProcessRunner;
  pollIntervalMs?: number;
  killGraceMs?: number;
}
const nativeRunner: ProcessRunner = (executable, args, options) => {
  const child = spawn(executable, [...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<{ code: number | null; signal?: string | null }>((resolve) => {
    child.on('error', () => {}); // close follows spawn errors and joins stdio.
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill(signal) {
      child.kill(signal);
    },
  };
};
function failure(message: string): DomainError {
  return new DomainError('archive-rejected', 422, message);
}

async function stagedBytes(directory: string): Promise<number> {
  let size = 0;
  for (const name of await readdir(directory)) {
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.isSymbolicLink())
      throw failure('CHD decoder produced an unsafe output');
    size += info.size;
    if (!Number.isSafeInteger(size)) throw failure('CHD decoder output exceeds quota');
  }
  return size;
}

async function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  runner: ProcessRunner,
  deadline: number,
  signal: AbortSignal | undefined,
  outputLimit: number | undefined,
  options: ChdProviderOptions,
): Promise<string> {
  checkDeadline(deadline, signal);
  let process: DecoderProcess;
  try {
    process = runner(executable, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    throw failure('CHD decoder could not start');
  }
  let fault: unknown;
  let logSize = 0;
  const output: Buffer[] = [];
  for (const [stream, capture] of [
    [process.stdout, true],
    [process.stderr, false],
  ] as const) {
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      logSize += bytes.length;
      if (logSize > 65536) fault ??= failure('CHD decoder exceeded its log budget');
      else if (capture) output.push(bytes);
    });
    stream.on('error', () => {
      fault ??= failure('CHD decoder output failed');
    });
  }
  const streams = Promise.all([finished(process.stdout), finished(process.stderr)]).catch(() => {
    fault ??= failure('CHD decoder output failed');
  });
  let exited = false;
  let result: { code: number | null; signal?: string | null } | undefined;
  const exit = process.exited.then(
    (value) => {
      exited = true;
      result = value;
    },
    () => {
      exited = true;
      fault ??= failure('CHD decoder failed');
    },
  );
  try {
    while (!exited) {
      checkDeadline(deadline, signal);
      if (fault) throw fault;
      if (outputLimit !== undefined && (await stagedBytes(cwd)) > outputLimit)
        throw failure('CHD decoder output exceeds quota');
      await Promise.race([
        exit,
        new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 20)),
      ]);
    }
    await streams;
    checkDeadline(deadline, signal);
    if (fault) throw fault;
    if (result?.code !== 0) throw failure('CHD decoder failed');
    return Buffer.concat(output).toString('utf8');
  } catch (error) {
    if (!exited) {
      process.kill('SIGTERM');
      await Promise.race([
        exit,
        new Promise((resolve) => setTimeout(resolve, options.killGraceMs ?? 100)),
      ]);
      if (!exited) process.kill('SIGKILL');
    }
    await exit;
    await streams;
    throw error;
  }
}

// The process runner enforces deadlines, bounded logs and output-overrun detection.
// Private cwd and polling are not an OS disk/memory sandbox for native code.
export async function createChdProvider(
  executable: string,
  options: ChdProviderOptions = {},
): Promise<VirtualContentProvider> {
  if (!isAbsolute(executable))
    throw new Error('CHD decoder configuration requires an absolute executable path');
  let resolved: string;
  try {
    resolved = await realpath(executable);
    await access(resolved, constants.X_OK);
    if (!(await lstat(resolved)).isFile()) throw new Error();
  } catch {
    throw new Error('CHD decoder configuration: executable is missing or not executable');
  }
  const runner = options.runner ?? nativeRunner;
  try {
    const deadline = performance.now() + 5000;
    for (const command of ['extractcd', 'extractdvd']) {
      const help = await runProcess(
        resolved,
        ['help', command],
        dirname(resolved),
        runner,
        deadline,
        undefined,
        undefined,
        options,
      );
      if (
        !help.includes(command) ||
        !help.includes('-i') ||
        !help.includes('-o') ||
        (command === 'extractcd' && !help.includes('-ob'))
      )
        throw new Error();
    }
  } catch {
    throw new Error(
      'CHD decoder configuration: chdman must support extractcd (-ob) and extractdvd; check the configured executable',
    );
  }
  let closed = false;
  let active = false;
  let reserved = 0;
  const jobs = new Set<{ controller: AbortController; done: Promise<unknown> }>();
  const queue: (() => void)[] = [];
  const provider: VirtualContentProvider = {
    format: 'chd',
    async inspect(path, quota, window) {
      const layout = await inspectChd(path, quota, window);
      return layout ? { entries: layout.entries } : null;
    },
    async resolve(path, entryId, quota) {
      const layout = await inspectChd(path, quota);
      const entry = layout?.entries.find((item) => item.entryId === entryId);
      return entry ? { kind: 'bundle', entry, bundleId: CHD_BUNDLE_ID } : null;
    },
    async materializeBundle(
      path,
      bundleId,
      destination,
      quota,
      signal,
    ): Promise<VirtualArtifactBundle> {
      const deadline = performance.now() + quota.timeoutMs;
      if (closed) rejectChd('CHD provider is closed');
      if (bundleId !== CHD_BUNDLE_ID || !isAbsolute(path)) rejectChd('Invalid CHD bundle or input');
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      let finish: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const job = { controller, done };
      jobs.add(job);
      let bytes = 0;
      let acquired = false;
      let reservationHeld = false;
      let staging: string | undefined;
      const published: string[] = [];
      try {
        const layout = await inspectChd(path, quota, undefined, deadline, controller.signal);
        if (!layout) rejectChd('Input is not a CHD');
        bytes = layout.totalSize;
        if (reserved + bytes > quota.maxExpandedBytes)
          rejectChd('CHD shared in-flight storage budget exceeded');
        reserved += bytes;
        reservationHeld = true;
        if (active) {
          if (queue.length >= 8) rejectChd('CHD decoder queue is full');
          let wake: () => void = () => {};
          const ready = new Promise<void>((resolve) => {
            wake = resolve;
          });
          queue.push(wake);
          try {
            let granted = false;
            void ready.then(() => {
              granted = true;
            });
            while (!granted) {
              checkDeadline(deadline, controller.signal);
              await Promise.race([
                ready,
                new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 20)),
              ]);
            }
            acquired = true;
          } catch (error) {
            const index = queue.indexOf(wake);
            if (index >= 0) queue.splice(index, 1);
            else {
              acquired = true;
            }
            throw error;
          }
        } else {
          active = true;
          acquired = true;
        }
        checkDeadline(deadline, controller.signal);
        const destinationInfo = await lstat(destination);
        if (
          !destinationInfo.isDirectory() ||
          destinationInfo.isSymbolicLink() ||
          (await readdir(destination)).length
        )
          rejectChd('CHD destination must be an empty regular directory');
        staging = await mkdtemp(join(dirname(destination), '.chd.partial-'));
        const work = staging;
        const args =
          layout.kind === 'dvd'
            ? ['extractdvd', '-i', path, '-o', join(work, 'disc.iso')]
            : [
                'extractcd',
                '-i',
                path,
                '-o',
                join(work, 'tool.cue'),
                '-ob',
                join(work, 'disc.bin'),
              ];
        // Permit bounded platform line-ending differences in the tool CUE,
        // while keeping the complete staging group within the caller's quota.
        const stagingLimit = Math.min(
          quota.maxExpandedBytes,
          layout.totalSize + (layout.cue === undefined ? 0 : 65536),
        );
        await runProcess(
          resolved,
          args,
          work,
          runner,
          deadline,
          controller.signal,
          stagingLimit,
          options,
        );
        const expected = layout.kind === 'dvd' ? ['disc.iso'] : ['disc.bin', 'tool.cue'];
        if (JSON.stringify((await readdir(work)).sort()) !== JSON.stringify(expected))
          rejectChd('CHD decoder produced unexpected output files');
        if ((await stagedBytes(work)) > stagingLimit) rejectChd('CHD decoder output exceeds quota');
        if (layout.cue !== undefined) {
          if ((await lstat(join(work, 'tool.cue'))).size > 65536)
            rejectChd('CHD decoder descriptor is too large');
          const descriptor = await readFile(join(work, 'tool.cue'), 'utf8');
          if (descriptor.replaceAll('\r\n', '\n') !== layout.cue)
            rejectChd('CHD decoder descriptor does not match the accepted layout');
          await rm(join(work, 'tool.cue'));
          await writeFile(join(work, 'disc.cue'), layout.cue, { flag: 'wx', mode: 0o600 });
        }
        const files: VirtualArtifactBundle['files'] = [];
        for (const entry of layout.entries) {
          checkDeadline(deadline, controller.signal);
          const output = join(work, entry.path);
          const info = await lstat(output);
          if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.uncompressedSize)
            rejectChd('CHD decoder output has the wrong size or type');
          const hash = await chdHash(output, deadline, controller.signal);
          checkDeadline(deadline, controller.signal);
          if (hash.size !== entry.uncompressedSize)
            rejectChd('CHD decoder output changed during validation');
          files.push({
            entryId: entry.entryId,
            path: entry.path,
            size: hash.size,
            sha256: hash.sha256,
          });
        }
        for (const file of files) {
          checkDeadline(deadline, controller.signal);
          await rename(join(work, file.path), join(destination, file.path));
          published.push(file.path);
        }
        return { version: CHD_VERSION, files };
      } catch (error) {
        await Promise.all(published.map((name) => rm(join(destination, name), { force: true })));
        throw error;
      } finally {
        try {
          if (staging) await rm(staging, { recursive: true, force: true });
        } finally {
          // Filesystem cleanup may fail after the process has already exited.
          // Bookkeeping and close joins still have to settle in every case.
          if (reservationHeld) reserved -= bytes;
          if (acquired) {
            const wake = queue.shift();
            if (wake) wake();
            else active = false;
          }
          signal?.removeEventListener('abort', abort);
          jobs.delete(job);
          finish();
        }
      }
    },
    async close() {
      closed = true;
      for (const job of jobs) job.controller.abort();
      await Promise.all([...jobs].map((job) => job.done));
    },
  };
  return provider;
}
