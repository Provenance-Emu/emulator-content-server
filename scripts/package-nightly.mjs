import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { bundle, deployPackage } from './bundle.mjs';

const platform =
  process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : process.platform;
if (!['macos', 'windows', 'linux'].includes(platform)) throw new Error('Unsupported platform');
const version = (await readFile('.nvmrc', 'utf8')).trim();
if (process.versions.node !== version) throw new Error(`Packaging requires Node ${version}`);
const tag = process.env.ECS_RELEASE_TAG || 'nightly';
if (
  tag !== 'nightly' &&
  !/^v(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
    tag,
  )
) {
  throw new Error('ECS_RELEASE_TAG must be a version tag');
}
const target = `${platform}-${process.arch}`;
const name = `Emulation-Server-${tag.replace(/^v/, '')}-${target}`;
const stage = resolve('dist/nightly', name);
// Hoisted deployment avoids absolute Windows junctions and extraction privileges.
await bundle(join(stage, 'server'), 'inherit', { portable: true });
await deployPackage('@ecs/plugin-host', join(stage, 'plugins'), 'inherit', { portable: true });
await copyFile('LICENSE', join(stage, 'plugins', 'LICENSE'));
await mkdir(join(stage, 'runtime'));
await copyFile(
  process.execPath,
  join(stage, 'runtime', platform === 'windows' ? 'node.exe' : 'node'),
);
await chmod(join(stage, 'runtime', platform === 'windows' ? 'node.exe' : 'node'), 0o755);
// setup-node uses the official Node distribution, which includes third-party notices.
const license = resolve(
  dirname(process.execPath),
  platform === 'windows' ? 'LICENSE' : '../LICENSE',
);
await copyFile(license, join(stage, 'runtime', 'LICENSE'));
await copyFile('docs/operations/nightly-builds.md', join(stage, 'INSTALL.md'));
for (const [command, entry] of [
  ['ecs', 'server/dist/src/supervise.js'],
  ['ecs-plugins', 'plugins/dist/src/main.js'],
]) {
  await writeFile(
    join(stage, command),
    '#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1\n' +
      `exec "$root/runtime/node" "$root/${entry}" "$@"\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(stage, `${command}.cmd`),
    `@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0${entry.replaceAll('/', '\\')}" %*\r\n`,
  );
}
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const metadata = {
  channel: tag === 'nightly' ? 'nightly' : 'release',
  version: tag === 'nightly' ? `nightly-${sha.slice(0, 12)}` : tag,
  sha,
  platform,
  arch: process.arch,
  node: version,
  builtAt: new Date().toISOString(),
  run: process.env.GITHUB_RUN_ID ?? null,
};
const build = {
  ...metadata,
  id: createHash('sha256')
    .update(JSON.stringify([tag, sha, target]))
    .digest('hex'),
};
await writeFile(join(stage, 'BUILD.json'), `${JSON.stringify(build, null, 2)}\n`);
const output = resolve('dist-release', tag);
await mkdir(output, { recursive: true });
const extension = platform === 'windows' ? '.zip' : '.tar.gz';
const archive = join(output, `${name}${extension}`);
if (platform === 'windows') {
  // Windows' bundled bsdtar crashes while creating this dependency tree. Use a native ZIP.
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$ErrorActionPreference = "Stop"; Compress-Archive -LiteralPath $env:ECS_NIGHTLY_STAGE -DestinationPath $env:ECS_NIGHTLY_ARCHIVE -CompressionLevel Optimal -Force',
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, ECS_NIGHTLY_STAGE: stage, ECS_NIGHTLY_ARCHIVE: archive },
    },
  );
} else {
  execFileSync('tar', ['-czf', archive, '-C', dirname(stage), name], { stdio: 'inherit' });
}
const digest = createHash('sha256')
  .update(await readFile(archive))
  .digest('hex');
await writeFile(
  join(output, `SHA256SUMS-server-${target}.txt`),
  `${digest}  ${name}${extension}\n`,
);
await writeFile(
  join(output, `ecs-update-${target}.json`),
  `${JSON.stringify({ build, archive: `${name}${extension}`, sha256: digest })}\n`,
);
console.log(archive);
