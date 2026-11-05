import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

function git(args, cwd, raw = false) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(`Pinned source operation failed: ${result.stderr || result.error?.message}`);
  return raw ? result.stdout : result.stdout.trim();
}
function links(path) {
  return git(['ls-tree', '-r', '-z', 'HEAD'], path, true)
    .split('\0')
    .filter(Boolean)
    .flatMap((row) => {
      const [header, name] = row.split('\t');
      const [mode, type, pin] = header.split(' ');
      return mode === '160000' && type === 'commit' ? [{ name, pin }] : [];
    });
}
function ownGitRoot(path) {
  if (!existsSync(path)) return false;
  try {
    return realpathSync(git(['rev-parse', '--show-toplevel'], path)) === realpathSync(path);
  } catch {
    return false;
  }
}
function moduleUrl(source, name) {
  const records = git(
    ['config', '--blob=HEAD:.gitmodules', '--get-regexp', '^submodule..*.path$'],
    source,
  ).split('\n');
  const entry = records
    .map((line) => {
      const at = line.indexOf(' ');
      return [line.slice(0, at), line.slice(at + 1)];
    })
    .find(([, value]) => value === name);
  if (!entry) throw new Error(`Missing pinned submodule metadata: ${name}`);
  const url = git(
    ['config', '--blob=HEAD:.gitmodules', '--get', entry[0].replace(/\.path$/, '.url')],
    source,
  );
  if (!url.startsWith('.')) return url;
  const origin = git(['remote', 'get-url', 'origin'], source);
  if (/^https?:\/\//.test(origin)) return new URL(url, `${origin}/`).href;
  if (origin.startsWith('/')) return resolve(origin, url);
  throw new Error(`Unsupported relative submodule source: ${name}`);
}

/** Copy committed Git objects only; never alter or copy caller working/build files. */
export function snapshotPinnedSource(source, destination, pin, modules = null, nested = false) {
  if (
    nested &&
    existsSync(destination) &&
    lstatSync(destination).isDirectory() &&
    !lstatSync(destination).isSymbolicLink() &&
    readdirSync(destination).length === 0
  )
    rmdirSync(destination);
  if (existsSync(destination)) throw new Error('Snapshot destination must be new');
  // init/fetch selects the gitlink commit even when a caller's submodule HEAD differs.
  git(['init', '--quiet', destination]);
  git(['config', 'core.autocrlf', 'false'], destination);
  git(['config', 'core.eol', 'lf'], destination);
  let origin = source;
  if (ownGitRoot(source)) {
    try {
      origin = git(['remote', 'get-url', 'origin'], source);
    } catch {}
  }
  git(['remote', 'add', 'origin', origin], destination);
  git(['fetch', '--quiet', '--depth', '1', '--no-tags', source, pin], destination);
  git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], destination);
  if (git(['rev-parse', 'HEAD'], destination) !== pin) throw new Error('Snapshot commit mismatch');
  for (const entry of links(destination)) {
    if (modules !== null && !modules.includes(entry.name)) continue;
    const candidate = join(source, entry.name);
    const childSource = ownGitRoot(candidate) ? candidate : moduleUrl(destination, entry.name);
    snapshotPinnedSource(childSource, join(destination, entry.name), entry.pin, null, true);
  }
  verifyPinnedSource(destination, pin, false, modules);
}

/** Validate every materialized recursive gitlink, including tracked child changes. */
export function verifyPinnedSource(path, pin, allowRootChanges = false, modules = null) {
  if (git(['rev-parse', 'HEAD'], path) !== pin)
    throw new Error(`Pinned source HEAD mismatch: ${path}`);
  if (
    !allowRootChanges &&
    git(['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none'], path)
  )
    throw new Error(`Pinned source has tracked changes: ${path}`);
  for (const entry of links(path)) {
    const child = join(path, entry.name);
    if (ownGitRoot(child)) verifyPinnedSource(child, entry.pin);
    else if (modules === null || modules.includes(entry.name))
      throw new Error(`Pinned submodule is missing: ${child}`);
  }
}

/** Include unneeded gitlinks in the receipt without fetching their platform-only code. */
export function pinnedSourceManifest(path) {
  return links(path).map((entry) => {
    const child = join(path, entry.name),
      materialized = ownGitRoot(child);
    return {
      path: entry.name,
      pin: entry.pin,
      materialized,
      children: materialized ? pinnedSourceManifest(child) : [],
    };
  });
}

/** zlib's pinned CMake renames a tracked header during out-of-tree configuration.
 * Restore only an exact committed copy after compilation, keeping child source clean. */
export function restoreZlibHeaderRename(core) {
  const child = join(core, 'core/deps/libchdr');
  const name = 'deps/zlib-1.3.1/zconf.h',
    header = join(child, name);
  if (existsSync(header)) return;
  const original = git(['show', `HEAD:${name}`], child, true);
  if (readFileSync(`${header}.included`, 'utf8') !== original)
    throw new Error('Unexpected zlib header rename content');
  writeFileSync(header, original, { flag: 'wx' });
}
