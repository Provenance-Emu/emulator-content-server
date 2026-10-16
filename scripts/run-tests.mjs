import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(directory, entry);
    const info = statSync(full);
    if (info.isDirectory()) walk(full);
    else if (full.endsWith('.test.js') && full.includes(`${join('dist', 'test')}`))
      files.push(full);
  }
}

walk(root);
for (const entry of readdirSync(join(root, 'scripts'))) {
  if (entry.endsWith('.test.mjs')) files.push(join(root, 'scripts', entry));
}
if (files.length === 0) {
  console.error('No compiled tests were found');
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', '--test', ...files],
  {
    stdio: 'inherit',
  },
);
process.exit(result.status ?? 1);
