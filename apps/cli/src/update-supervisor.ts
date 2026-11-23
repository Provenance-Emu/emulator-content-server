import { type ChildProcess, fork } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildIdPattern,
  lockUpdateFile,
  prepareUpdateDirectory,
  readUpdateState,
  runtime,
  type UpdateState,
  writeJson,
} from './update-files.js';

const cli = (root: string) => join(root, 'server', 'dist', 'src', 'main.js');

export async function supervise(
  dataDir: string,
  args: string[],
  initialRoot: string,
  options: { stopGraceMs?: number } = {},
): Promise<void> {
  const directory = await prepareUpdateDirectory(dataDir);
  const stateFile = join(directory, 'state.json');
  const builds = join(directory, 'builds');
  // SQLite releases these leases on exit, including after a launcher crash.
  const lock = lockUpdateFile(directory, 'supervisor');
  let updateLock: DatabaseSync | undefined;
  const releaseUpdateLock = () => {
    updateLock?.close();
    updateLock = undefined;
  };
  let child: ChildProcess | undefined;
  let stopping = false;
  // The person who owns this process may restart, stop and start the server behind it with a
  // signal, so a boot service needs no administrator for that. The launcher stays up while the
  // server is stopped; otherwise the service manager would start another.
  let paused = false;
  let restarting = false;
  /** False while an update is being tried or installed: those finish undisturbed. */
  let controllable = false;
  let wake: (() => void) | undefined;
  const end = (server: ChildProcess) => {
    if (server.connected) server.send({ type: 'ecs-stop' }, () => {});
    else server.kill('SIGTERM');
    // A server that no longer answers is the one somebody most wants to restart.
    const kill = setTimeout(() => server.kill('SIGKILL'), options.stopGraceMs ?? 30_000);
    kill.unref();
    server.once('exit', () => clearTimeout(kill));
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (child) end(child);
    wake?.();
  };
  // A request that arrives while a build is starting or an update is installing is kept and
  // carried out once that has finished, so it is never answered and then dropped.
  const restart = () => {
    if (stopping) return;
    if (paused) {
      paused = false;
      // Still shutting down from the stop: start again as soon as it has.
      if (child) restarting = true;
      else wake?.();
      return;
    }
    if (restarting) return;
    restarting = true;
    if (child && controllable) end(child);
  };
  const pause = () => {
    if (stopping || paused) return;
    paused = true;
    if (child && controllable && !restarting) end(child);
    restarting = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.platform !== 'win32') {
    process.on('SIGHUP', restart);
    process.on('SIGUSR2', pause);
  }
  try {
    let state = await readUpdateState(directory);
    if (state.pending) {
      updateLock = lockUpdateFile(directory, 'commands', true, 10_000);
      const worker = lockUpdateFile(directory, 'worker', true, 10_000);
      try {
        await restoreCatalog(dataDir, directory);
        state = { active: state.active, failed: state.pending };
        await writeJson(stateFile, state);
      } finally {
        worker.close();
        releaseUpdateLock();
      }
    }
    for (const file of await readdir(directory)) {
      if (file.startsWith('download-'))
        await rm(join(directory, file), { recursive: true, force: true });
    }
    while (!stopping) {
      const trial = state.pending;
      const previous = state.active;
      const selected = trial ?? previous;
      const root = selected ? join(builds, selected) : initialRoot;
      const server = fork(cli(root), args, {
        execPath: runtime(root),
        execArgv: [],
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, ECS_SERVER_BOOTSTRAP: initialRoot },
      });
      child = server;
      controllable = false;
      // A restart asked for while nothing was running is met by this start.
      restarting = false;
      let requested: string | undefined;
      let activated = false;
      let activation: Promise<void> | undefined;
      const startupTimeout = trial ? setTimeout(() => server.kill('SIGKILL'), 90_000) : undefined;
      server.on('message', (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const message = value as { type?: string; id?: string };
        if (message.type === 'ecs-ready' && !activation && !stopping) {
          activation = (async () => {
            if (trial) {
              await writeJson(stateFile, { active: trial });
              state = { active: trial };
              releaseUpdateLock();
            }
            activated = true;
            controllable = !stopping;
            clearTimeout(startupTimeout);
            if (controllable && (paused || restarting)) {
              end(server);
              return;
            }
            if (server.connected)
              server.send(
                { type: stopping ? 'ecs-stop' : 'ecs-activate', failed: state.failed },
                () => {},
              );
          })();
          void activation.catch(() => server.kill('SIGKILL'));
        }
        if (
          message.type === 'ecs-install' &&
          activated &&
          !stopping &&
          !requested &&
          !paused &&
          !restarting &&
          typeof message.id === 'string' &&
          buildIdPattern.test(message.id) &&
          message.id !== selected
        ) {
          try {
            updateLock = lockUpdateFile(directory, 'commands');
          } catch {
            if (server.connected) server.send({ type: 'ecs-update-busy' }, () => {});
            return;
          }
          requested = message.id;
          controllable = false;
          if (server.connected) server.send({ type: 'ecs-stop' }, () => {});
        }
      });
      const code = await exitStatus(server);
      child = undefined;
      clearTimeout(startupTimeout);
      await activation?.catch(() => {});
      if (trial && !activated) {
        await restoreCatalog(dataDir, directory);
        state = { active: previous, failed: trial };
        await writeJson(stateFile, state);
        releaseUpdateLock();
        console.error('Server update failed to start. Restored the previous build and catalog.');
        continue;
      }
      if (
        stopping ||
        (code !== 0 && !paused && !restarting) ||
        (!requested && !paused && !restarting)
      ) {
        process.exitCode = stopping ? 0 : (code ?? 1);
        return;
      }
      if (requested && code === 0) {
        try {
          await backupCatalog(dataDir, directory);
          await writeJson(stateFile, { ...state, pending: requested });
          state = { ...state, pending: requested };
        } catch {
          state = { active: state.active, failed: requested };
          await writeJson(stateFile, state);
          releaseUpdateLock();
          console.error(
            'Server update could not back up the catalog. Restarting the previous build.',
          );
        }
        await pruneBuilds(builds, state);
      } else {
        releaseUpdateLock();
      }
      while (paused && !stopping) {
        // An idle timer keeps this process alive; a pending promise alone would not.
        const idle = setInterval(() => {}, 60_000);
        await new Promise<void>((resume) => {
          wake = resume;
        });
        wake = undefined;
        clearInterval(idle);
      }
      if (stopping) {
        process.exitCode = 0;
        return;
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', restart);
    process.off('SIGUSR2', pause);
    releaseUpdateLock();
    lock.close();
  }
}

export function exitStatus(child: ChildProcess): Promise<number | null> {
  return new Promise((done) => {
    child.once('error', () => done(null));
    child.once('exit', done);
  });
}

async function backupCatalog(dataDir: string, directory: string): Promise<void> {
  const backup = join(directory, 'rollback.sqlite');
  await rm(backup, { force: true });
  const database = new DatabaseSync(join(dataDir, 'library.sqlite'));
  try {
    database.prepare('VACUUM INTO ?').run(backup);
    await chmod(backup, 0o600);
  } finally {
    database.close();
  }
}

async function restoreCatalog(dataDir: string, directory: string): Promise<void> {
  const catalog = join(dataDir, 'library.sqlite');
  const restore = join(directory, 'restore.sqlite');
  await rm(restore, { force: true });
  await copyFile(join(directory, 'rollback.sqlite'), restore, constants.COPYFILE_EXCL);
  await rm(`${catalog}-wal`, { force: true });
  await rm(`${catalog}-shm`, { force: true });
  await rename(restore, catalog);
}

async function pruneBuilds(directory: string, state: UpdateState): Promise<void> {
  for (const id of await readdir(directory)) {
    if (buildIdPattern.test(id) && id !== state.active && id !== state.pending) {
      await rm(join(directory, id), { recursive: true, force: true }).catch(() => {});
    }
  }
}
