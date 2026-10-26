import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin') throw new Error('macOS packaging requires a macOS host');
const bundle = resolve('apps/tray/src-tauri/target/release/bundle');
const app = join(bundle, 'macos/Emulation Server.app');
await stat(join(app, 'Contents/MacOS/ecs-tray'));
const stage = await mkdtemp(join(tmpdir(), 'emulation-server-dmg-'));
const output = join(bundle, 'dmg');
try {
  await mkdir(output, { recursive: true });
  await cp(app, join(stage, 'Emulation Server.app'), { recursive: true });
  await symlink('/Applications', join(stage, 'Applications'));
  const version = JSON.parse(await readFile('apps/tray/src-tauri/tauri.conf.json', 'utf8')).version;
  const destination = join(output, `Emulation Server_${version}_${process.arch}.dmg`);
  // A drag-to-Applications image needs no Finder scripting or desktop session.
  execFileSync(
    '/usr/bin/hdiutil',
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
  console.log(destination);
} finally {
  await rm(stage, { recursive: true, force: true });
}
