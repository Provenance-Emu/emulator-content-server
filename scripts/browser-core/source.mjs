import { spawnSync } from 'node:child_process';

function git(arguments_, cwd) {
  const result = spawnSync('git', arguments_, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0)
    throw new Error(`Git source snapshot failed: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}

/** Export committed inputs only; operator ignored/untracked build files never enter the build. */
export function snapshotSource(source, destination, commit) {
  if (git(['rev-parse', 'HEAD'], source) !== commit)
    throw new Error('Source snapshot does not match the pinned commit');
  git(['clone', '--no-local', '--no-checkout', '--depth', '1', '--quiet', source, destination]);
  git(['checkout', '--detach', '--quiet', commit], destination);
  if (git(['rev-parse', 'HEAD'], destination) !== commit)
    throw new Error('Cloned source snapshot does not match the pinned commit');
}
