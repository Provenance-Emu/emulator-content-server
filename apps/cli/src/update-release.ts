import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import {
  archiveBase,
  type Build,
  extension,
  isBuild,
  readJson,
  releaseTagPattern,
  runtime,
  target,
} from './update-files.js';

const repository = 'Provenance-Emu/emulator-content-server';
const api = `https://api.github.com/repos/${repository}/releases`;
const manifestName = `ecs-update-${target}.json`;
const maxArchiveBytes = 512 * 1024 * 1024;

interface Asset {
  name: string;
  size: number;
  digest?: string;
}

interface Release {
  tag_name: string;
  draft: boolean;
  assets: Asset[];
}

export interface UpdateCandidate {
  build: Build;
  url: string;
  digest: string;
  size: number;
}

function downloadUrl(tag: string, file: string): string {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${file}`;
}

async function getJson(url: string, signal: AbortSignal, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: { accept: 'application/json' },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub update check returned HTTP ${response.status}`);
  return response.json();
}

export async function findUpdate(
  channel: Build['channel'],
  current: Build,
  signal: AbortSignal,
  fetcher = fetch,
): Promise<UpdateCandidate | undefined> {
  if (channel === 'nightly') {
    const release = (await getJson(`${api}/tags/nightly`, signal, fetcher)) as Release | null;
    return release ? candidate(release, channel, current, signal, fetcher) : undefined;
  }
  // GitHub's /latest can point to browser cores or catalog publications. Look
  // for tagged server releases with the updater manifest and compatible archive.
  for (let page = 1; page <= 3; page++) {
    const releases = (await getJson(`${api}?per_page=30&page=${page}`, signal, fetcher)) as
      | Release[]
      | null;
    if (!releases) break;
    for (const release of releases) {
      if (!releaseTagPattern.test(release.tag_name)) continue;
      if (current.channel === 'release' && compareTags(release.tag_name, current.version) <= 0)
        continue;
      const update = await candidate(release, channel, current, signal, fetcher);
      if (update) return update;
    }
    if (releases.length < 30) break;
  }
}

function compareTags(first: string, second: string): number {
  const [firstVersion = '', firstPre] = first.split(/-(.*)/s);
  const [secondVersion = '', secondPre] = second.split(/-(.*)/s);
  const compare = (left: string, right: string) =>
    left.localeCompare(right, 'en', { numeric: true });
  return (
    compare(firstVersion, secondVersion) ||
    (firstPre && secondPre ? compare(firstPre, secondPre) : Number(!firstPre) - Number(!secondPre))
  );
}

async function candidate(
  release: Release,
  channel: Build['channel'],
  current: Build,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<UpdateCandidate | undefined> {
  const tag = release.tag_name;
  if (release.draft || (channel === 'nightly' && tag !== 'nightly')) return;
  const filename = `${archiveBase(tag)}.${extension}`;
  const archive = release.assets.find((asset) => asset.name === filename);
  const manifest = release.assets.find((asset) => asset.name === manifestName);
  if (!archive || !manifest) return;
  if (manifest.size > 4096 || archive.size < 1 || archive.size > maxArchiveBytes) {
    throw new Error('GitHub update assets exceed the supported size');
  }
  const value = (await getJson(downloadUrl(tag, manifestName), signal, fetcher)) as {
    build?: unknown;
    archive?: unknown;
    sha256?: unknown;
  } | null;
  if (
    !value ||
    !isBuild(value.build) ||
    value.build.channel !== channel ||
    (channel === 'release' && value.build.version !== tag) ||
    value.archive !== filename ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    (archive.digest && archive.digest !== `sha256:${value.sha256}`)
  ) {
    throw new Error('GitHub is publishing an update or the server manifest is invalid');
  }
  const build = value.build;
  if (
    build.id === current.id ||
    (channel === 'nightly' &&
      current.channel === channel &&
      (build.sha === current.sha || Date.parse(build.builtAt) <= Date.parse(current.builtAt)))
  )
    return;
  return { build, url: downloadUrl(tag, filename), digest: value.sha256, size: archive.size };
}

export async function stageUpdate(
  directory: string,
  update: UpdateCandidate,
  signal: AbortSignal,
  fetcher = fetch,
): Promise<void> {
  const scratch = await mkdtemp(join(directory, 'download-'));
  try {
    const filename = join(scratch, `server.${extension}`);
    const response = await fetcher(update.url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]),
    });
    if (!response.ok || !response.body) {
      throw new Error(`GitHub download returned HTTP ${response.status}`);
    }
    let size = 0;
    const hash = createHash('sha256');
    const checksum = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > update.size) return done(new Error('Server archive is larger than expected'));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.from(response.body),
      checksum,
      createWriteStream(filename, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (size !== update.size || hash.digest('hex') !== update.digest) {
      throw new Error('Server archive checksum did not match its GitHub manifest');
    }
    await extract(filename, scratch, signal);
    const name = archiveBase(update.build.channel === 'nightly' ? 'nightly' : update.build.version);
    const extracted = join(scratch, name);
    const build = await readJson(join(extracted, 'BUILD.json'));
    if (
      !isBuild(build) ||
      build.id !== update.build.id ||
      build.sha !== update.build.sha ||
      build.channel !== update.build.channel ||
      build.version !== update.build.version ||
      build.builtAt !== update.build.builtAt
    ) {
      throw new Error('Downloaded server build does not match the update manifest');
    }
    for (const file of [runtime(extracted), join(extracted, 'server', 'dist', 'src', 'main.js')]) {
      if (!(await stat(file)).isFile())
        throw new Error('Server archive is missing its runtime or CLI');
    }
    const destination = join(directory, 'builds', build.id);
    // A previous interrupted download or failed activation may have left this
    // candidate staged. Only a fully verified extraction replaces it.
    await rm(destination, { recursive: true, force: true });
    await rename(extracted, destination);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function extract(file: string, directory: string, signal: AbortSignal): Promise<void> {
  const run = promisify(execFile);
  if (process.platform === 'win32') {
    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:ECS_UPDATE_ARCHIVE -DestinationPath $env:ECS_UPDATE_EXTRACT',
      ],
      {
        signal,
        timeout: 180_000,
        windowsHide: true,
        env: { ...process.env, ECS_UPDATE_ARCHIVE: file, ECS_UPDATE_EXTRACT: directory },
      },
    );
  } else {
    await run('tar', ['-xzf', file, '-C', directory], { signal, timeout: 180_000 });
  }
}
