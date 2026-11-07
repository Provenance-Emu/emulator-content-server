import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, lstat, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// pnpm deploy may hardlink source build output. A running installation must be a snapshot.
async function detachBuildFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await detachBuildFiles(path);
    else if (entry.isFile() && (await lstat(path)).nlink > 1) {
      const temporary = `${path}.ecs-copy-${randomUUID()}`;
      try {
        await copyFile(path, temporary);
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
}

export async function deployPackage(filter, destination, stdio, { portable = false } = {}) {
  const target = resolve(destination);
  const existing = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (!existing.isDirectory() || (await readdir(target)).length > 0)) {
    throw new Error('Bundle destination must be an absent or empty directory, never a symlink');
  }
  // Windows cannot execute pnpm.cmd directly without a shell. Invoke pnpm's JS entrypoint.
  const pnpmScript = process.env.npm_execpath;
  if (process.platform === 'win32' && !pnpmScript) {
    throw new Error('On Windows, run bundling through a pnpm package script');
  }
  const deployed = spawnSync(
    pnpmScript ? process.execPath : 'pnpm',
    [
      ...(pnpmScript ? [pnpmScript] : []),
      '--filter',
      filter,
      'deploy',
      '--prod',
      ...(portable ? ['--config.node-linker=hoisted'] : []),
      '--legacy',
      '--no-force',
      target,
    ],
    { cwd: root, env: { ...process.env, CI: 'true', npm_config_force: 'false' }, stdio },
  );
  if (deployed.error) throw deployed.error;
  if (deployed.status !== 0) throw new Error(`Production deployment failed (${deployed.status})`);
  await detachBuildFiles(target);
  return target;
}

/** Deploy the already built production graph and its first-party web interface. */
export async function bundle(destination, stdio = 'inherit', options = {}) {
  const web = resolve(root, 'apps/web/dist');
  await stat(resolve(web, 'index.html'));
  const target = await deployPackage('@provenance-content/server', destination, stdio, options);
  await cp(web, resolve(target, 'ui'), { recursive: true });
  await cp(resolve(root, 'LICENSE'), resolve(target, 'LICENSE'));
  await cp(resolve(root, 'docs/operations/first-version.md'), resolve(target, 'FIRST-VERSION.md'));
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await bundle(process.argv[2] ?? resolve(root, 'dist/server'));
}
