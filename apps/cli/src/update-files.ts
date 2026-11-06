import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ServerUpdateBuild } from '@ecs/protocol';

export const buildIdPattern = /^[a-f0-9]{64}$/;
export const releaseTagPattern =
  /^v(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
export const platform =
  process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : process.platform;
export const extension = platform === 'windows' ? 'zip' : 'tar.gz';
export const target = `${platform}-${process.arch}`;

export interface Build extends ServerUpdateBuild {
  sha: string;
  builtAt: string;
  platform: string;
  arch: string;
}

export interface UpdateState {
  active?: string;
  pending?: string;
  failed?: string;
}

export function isBuild(value: unknown): value is Build {
  if (!value || typeof value !== 'object') return false;
  const build = value as Partial<Build>;
  return (
    typeof build.id === 'string' &&
    buildIdPattern.test(build.id) &&
    typeof build.version === 'string' &&
    (build.channel === 'nightly'
      ? /^nightly-[a-f0-9]{12}$/.test(build.version)
      : build.channel === 'release' && releaseTagPattern.test(build.version)) &&
    typeof build.sha === 'string' &&
    /^[a-f0-9]{40}$/.test(build.sha) &&
    typeof build.builtAt === 'string' &&
    Number.isFinite(Date.parse(build.builtAt)) &&
    build.platform === platform &&
    build.arch === process.arch
  );
}

export function runtime(root: string): string {
  return join(root, 'runtime', platform === 'windows' ? 'node.exe' : 'node');
}

export function archiveBase(tag: string): string {
  return `Emulation-Server-${tag.replace(/^v/, '')}-${target}`;
}

export function updateDirectory(dataDir: string): string {
  return join(dataDir, 'server-updates');
}

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx', flush: true });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function readUpdateState(directory: string): Promise<UpdateState> {
  const value = await readJson(join(directory, 'state.json'));
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid server update state');
  }
  const state = value as UpdateState;
  for (const id of [state.active, state.pending, state.failed]) {
    if (id !== undefined && (typeof id !== 'string' || !buildIdPattern.test(id))) {
      throw new Error('Invalid server update build ID');
    }
  }
  return state;
}

export async function prepareUpdateDirectory(dataDir: string): Promise<string> {
  const directory = updateDirectory(dataDir);
  await mkdir(join(directory, 'builds'), { recursive: true, mode: 0o700 });
  return directory;
}

export function lockUpdateFile(
  directory: string,
  name: 'supervisor' | 'commands' | 'worker',
  exclusive = true,
  timeout = 0,
): DatabaseSync {
  const database = new DatabaseSync(join(directory, `${name}.sqlite`));
  try {
    database.exec(
      `PRAGMA busy_timeout = ${timeout}; BEGIN ${exclusive ? 'EXCLUSIVE' : 'DEFERRED'}`,
    );
    if (!exclusive) database.prepare('SELECT name FROM sqlite_master').all();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
