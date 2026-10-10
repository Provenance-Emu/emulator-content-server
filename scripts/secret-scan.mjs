import { readdirSync, readFileSync, statSync } from 'node:fs';
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
const skip = new Set(['node_modules', 'dist', '.git', 'content-data']);
const failures = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (skip.has(entry)) continue;
    const full = join(directory, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      walk(full);
      continue;
    }
    if (info.size > 2_000_000) continue;
    const extension = extname(entry).toLowerCase();
    if (bannedExtensions.has(extension) && !full.endsWith('.d.ts')) {
      failures.push(`fixture extension is not allowed: ${full}`);
    }
    if (!/\.(md|ts|js|mjs|yml|yaml|json|swift|txt)$/.test(entry)) continue;
    const text = readFileSync(full, 'utf8');
    for (const pattern of patterns) {
      if (pattern.test(text)) failures.push(`secret pattern ${pattern} matched ${full}`);
    }
  }
}

walk(root);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('secret and fixture scan passed');
