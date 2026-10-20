import { spawnSync } from 'node:child_process';

function git(arguments_, cwd, raw = false) {
  const result = spawnSync('git', arguments_, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0)
    throw new Error(`Git source snapshot failed: ${result.stderr || result.error?.message}`);
  return raw ? result.stdout : result.stdout.trim();
}

/** Export committed inputs only; operator ignored/untracked build files never enter the build. */
export function snapshotSource(source, destination, commit) {
  if (git(['rev-parse', 'HEAD'], source) !== commit)
    throw new Error('Source snapshot does not match the pinned commit');
  git([
    'clone',
    '--config',
    'core.autocrlf=false',
    '--config',
    'core.eol=lf',
    '--no-local',
    '--no-checkout',
    '--depth',
    '1',
    '--quiet',
    source,
    destination,
  ]);
  git(['checkout', '--detach', '--quiet', commit], destination);
  if (git(['rev-parse', 'HEAD'], destination) !== commit)
    throw new Error('Cloned source snapshot does not match the pinned commit');
}

/** Compare canonical Git content, independently of display settings and checkout EOL. */
export function validatePatchedSource(source, expectedSnapshot, allowedFile) {
  const changed = git(
    ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--'],
    source,
    true,
  )
    .split('\0')
    .filter(Boolean);
  if (changed.length === 0) return;
  if (
    changed.length !== 1 ||
    changed[0] !== allowedFile ||
    git(['hash-object', `--path=${allowedFile}`, '--', allowedFile], source) !==
      git(['hash-object', `--path=${allowedFile}`, '--', allowedFile], expectedSnapshot)
  )
    throw new Error('RetroArch checkout contains changes other than the required patch');
}
