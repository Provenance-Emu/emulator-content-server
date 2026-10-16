import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const allowed = {
  '@ecs/protocol': [],
  '@ecs/domain': ['@ecs/protocol'],
  '@ecs/storage': ['@ecs/domain'],
  '@ecs/auth': ['@ecs/domain'],
  '@ecs/database': ['@ecs/domain'],
  '@ecs/discovery': [],
  '@ecs/client': ['@ecs/protocol'],
  '@ecs/signing': [],
  '@ecs/plugins': [],
  '@ecs/web': ['@ecs/client'],
  '@ecs/tray': ['@ecs/client', '@ecs/web'],
  '@ecs/server': [
    '@ecs/auth',
    '@ecs/database',
    '@ecs/discovery',
    '@ecs/domain',
    '@ecs/protocol',
    '@ecs/storage',
  ],
  '@ecs/plugin-host': ['@ecs/client', '@ecs/plugins', '@ecs/protocol', '@ecs/signing'],
  '@provenance-content/server': [
    '@ecs/auth',
    '@ecs/database',
    '@ecs/discovery',
    '@ecs/protocol',
    '@ecs/server',
    '@ecs/storage',
  ],
};
const locations = {
  '@ecs/protocol': 'packages/protocol',
  '@ecs/domain': 'packages/domain',
  '@ecs/storage': 'packages/storage',
  '@ecs/auth': 'packages/auth',
  '@ecs/database': 'packages/database',
  '@ecs/discovery': 'packages/discovery',
  '@ecs/client': 'packages/client-ts',
  '@ecs/signing': 'packages/signing',
  '@ecs/plugins': 'packages/plugins',
  '@ecs/web': 'apps/web',
  '@ecs/tray': 'apps/tray',
  '@ecs/server': 'apps/server',
  '@ecs/plugin-host': 'apps/plugins',
  '@provenance-content/server': 'apps/cli',
};

const failures = [];
for (const [name, dependencies] of Object.entries(allowed)) {
  const manifest = JSON.parse(readFileSync(join(root, locations[name], 'package.json'), 'utf8'));
  const actual = Object.keys(manifest.dependencies ?? {})
    .filter(
      (dependency) =>
        dependency.startsWith('@ecs/') || dependency.startsWith('@provenance-content/'),
    )
    .sort();
  const expected = [...dependencies].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${name} depends on ${actual.join(', ') || '(none)'} but the boundary allows ${expected.join(', ') || '(none)'}`,
    );
  }
  for (const [file, imported] of internalImports(join(root, locations[name], 'src'))) {
    if (!expected.includes(imported)) {
      failures.push(`${file} imports ${imported}, which ${name} may not depend on`);
    }
  }
}

/**
 * Shipped code that reaches for another package, which the manifest alone does
 * not rule out: a dev dependency satisfies the resolver, and a test is entitled
 * to one, so only `src` is read here.
 */
function internalImports(directory) {
  const found = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|svelte|mjs)$/.test(entry.name)) continue;
      const text = readFileSync(full, 'utf8');
      for (const match of text.matchAll(/from\s+'(@ecs\/[^'/]+|@provenance-content\/[^'/]+)/g)) {
        found.push([full.slice(root.length), match[1]]);
      }
    }
  };
  if (statSync(directory, { throwIfNoEntry: false })?.isDirectory()) walk(directory);
  return found;
}
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('package boundaries passed');
