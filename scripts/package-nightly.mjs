import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { bundle } from './bundle.mjs';

const platform =
  process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : process.platform;
if (!['macos', 'windows', 'linux'].includes(platform)) throw new Error('Unsupported platform');
const version = (await readFile('.nvmrc', 'utf8')).trim();
if (process.versions.node !== version) throw new Error(`Packaging requires Node ${version}`);
const name = `Emulation-Server-nightly-${platform}-${process.arch}`;
const stage = resolve('dist/nightly', name);
// Hoisted deployment avoids absolute Windows junctions and extraction privileges.
await bundle(join(stage, 'server'), 'inherit', { portable: true });
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
await writeFile(
  join(stage, 'ecs'),
  '#!/bin/sh\nECS_HOME=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$ECS_HOME/runtime/node" "$ECS_HOME/server/dist/src/main.js" "$@"\n',
  { mode: 0o755 },
);
await writeFile(
  join(stage, 'ecs.cmd'),
  '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0server\\dist\\src\\main.js" %*\r\n',
);
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
await writeFile(
  join(stage, 'BUILD.json'),
  `${JSON.stringify({ channel: 'nightly', sha, platform, arch: process.arch, node: version, builtAt: new Date().toISOString(), run: process.env.GITHUB_RUN_ID ?? null }, null, 2)}\n`,
);
const output = resolve('dist-release/nightly');
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
  join(output, `SHA256SUMS-server-${platform}-${process.arch}.txt`),
  `${digest}  ${name}${extension}\n`,
);
console.log(archive);
