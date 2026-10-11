import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bannedExtensions = new Set([
  '.nes',
  '.sfc',
  '.smc',
  '.z64',
  '.n64',
  '.gdi',
  '.cue',
  '.chd',
  '.iso',
  '.rvz',
  '.wbfs',
  '.gcm',
  '.bin',
]);
const patterns = [/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/];
const failures = [];

/**
 * Every file that could reach a commit: tracked, plus untracked that is not
 * ignored. Walking the whole tree instead would scan build output, and a Rust
 * target directory is full of `.bin` files that no one is about to commit.
 */
function candidates() {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return listed.split('\0').filter(Boolean);
}

for (const relative of candidates()) {
  const full = join(root, relative);
  const info = statSync(full, { throwIfNoEntry: false });
  if (!info?.isFile() || info.size > 2_000_000) continue;
  const extension = extname(relative).toLowerCase();
  if (bannedExtensions.has(extension) && !relative.endsWith('.d.ts')) {
    failures.push(`fixture extension is not allowed: ${relative}`);
  }
  if (!/\.(md|ts|js|mjs|yml|yaml|json|swift|txt|rs|toml|svelte|html|css|plist)$/.test(relative)) {
    continue;
  }
  const text = readFileSync(full, 'utf8');
  for (const pattern of patterns) {
    if (pattern.test(text)) failures.push(`secret pattern ${pattern} matched ${relative}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('secret and fixture scan passed');
