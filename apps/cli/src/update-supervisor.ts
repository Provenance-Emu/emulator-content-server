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
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (child?.connected) child.send({ type: 'ecs-stop' }, () => {});
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
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
            clearTimeout(startupTimeout);
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
      if (stopping || code !== 0 || !requested) {
        process.exitCode = stopping ? 0 : (code ?? 1);
        return;
      }
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
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
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
