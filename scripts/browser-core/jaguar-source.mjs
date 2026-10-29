import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

function git(args, cwd, binary = false) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: binary ? undefined : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Pinned build input unavailable');
  return result.stdout;
}
function blobHash(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** One source copy, no duplicated Git object store. Every working byte is checked
 * against its committed blob before APFS/reflink copying; modifications fall back
 * to the immutable commit. Ignored objects, media and user files are never read. */
export function snapshotJaguarBuildSource(source, destination, pin, exclude = () => false) {
  if (git(['rev-parse', 'HEAD'], source).trim() !== pin) throw new Error('Source pin mismatch');
  mkdirSync(destination);
  for (const row of git(['ls-tree', '-r', '-z', pin], source).split('\0').filter(Boolean)) {
    const [header, file] = row.split('\t');
    const [mode, type, hash] = header.split(' ');
    if (type !== 'blob' || exclude(file)) continue;
    if (!['100644', '100755', '120000'].includes(mode) || !file || file.split('/').includes('..'))
      throw new Error('Unsupported source entry');
    const input = join(source, file),
      output = join(destination, file);
    if (mode === '120000') {
      const target = git(['show', `${pin}:${file}`], source);
      const inside = relative(destination, resolve(dirname(output), target));
      if (isAbsolute(target) || inside === '..' || inside.startsWith('../') || isAbsolute(inside))
        throw new Error('Source symlink escapes snapshot');
      mkdirSync(dirname(output), { recursive: true });
      symlinkSync(target, output);
      continue;
    }
    let exact = false;
    try {
      const info = lstatSync(input);
      if (info.isFile() && info.size <= 64 * 1024 * 1024) {
        const bytes = readFileSync(input);
        exact = blobHash(bytes) === hash;
      }
    } catch {
      /* Missing working bytes can still be read from the pinned commit. */
    }
    mkdirSync(dirname(output), { recursive: true });
    if (exact) {
      copyFileSync(input, output, constants.COPYFILE_FICLONE);
      // A concurrent editor must not change the committed build identity between
      // verification and copy. Recheck our independent snapshot before using it.
      exact = lstatSync(output).size <= 64 * 1024 * 1024 && blobHash(readFileSync(output)) === hash;
    }
    if (!exact) writeFileSync(output, git(['show', `${pin}:${file}`], source, true));
    chmodSync(output, mode === '100755' ? 0o755 : 0o644);
  }
}
