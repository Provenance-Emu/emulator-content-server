import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin') throw new Error('macOS packaging requires a macOS host');
const bundle = resolve(process.argv[2] ?? 'apps/tray/src-tauri/target/release/bundle');
const app = join(bundle, 'macos/Emulation Server.app');
await stat(join(app, 'Contents/MacOS/ecs-tray'));
const temporary = await mkdtemp(join(tmpdir(), 'emulation-server-dmg-'));
const stage = join(temporary, 'contents');
const stagedApp = join(stage, 'Emulation Server.app');
const mount = join(temporary, 'mounted');
const output = join(bundle, 'dmg');
const codesign = '/usr/bin/codesign';
const hdiutil = '/usr/bin/hdiutil';
const verify = ['--verify', '--deep', '--strict'];
try {
  await mkdir(output, { recursive: true });
  await mkdir(stage);
  execFileSync('/usr/bin/ditto', [app, stagedApp]);
  // Apple Silicon's linker signature seals the executable only. Unsigned test
  // builds still need the assembled bundle's resources sealed as a unit.
  if (
    !process.env.APPLE_SIGNING_IDENTITY &&
    spawnSync(codesign, [...verify, stagedApp], { stdio: 'ignore' }).status !== 0
  ) {
    execFileSync(codesign, ['--force', '--sign', '-', stagedApp], { stdio: 'inherit' });
  }
  execFileSync(codesign, [...verify, stagedApp], { stdio: 'inherit' });
  await symlink('/Applications', join(stage, 'Applications'));
  const version = JSON.parse(await readFile('apps/tray/src-tauri/tauri.conf.json', 'utf8')).version;
  const destination = join(output, `Emulation Server_${version}_${process.arch}.dmg`);
  // A drag-to-Applications image needs no Finder scripting or desktop session.
  execFileSync(
    hdiutil,
    [
      'create',
      '-volname',
      'Emulation Server',
      '-srcfolder',
      stage,
      '-ov',
      '-format',
      'UDZO',
      '-fs',
      'HFS+',
      destination,
    ],
    { stdio: 'inherit' },
  );
  await mkdir(mount);
  execFileSync(hdiutil, ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, destination]);
  try {
    execFileSync(codesign, [...verify, join(mount, 'Emulation Server.app')], { stdio: 'inherit' });
  } finally {
    execFileSync(hdiutil, ['detach', mount], { stdio: 'inherit' });
  }
  console.log(destination);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
