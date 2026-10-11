import { readFileSync } from 'node:fs';
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
  '@ecs/web': ['@ecs/client'],
  '@ecs/server': [
    '@ecs/auth',
    '@ecs/database',
    '@ecs/discovery',
    '@ecs/domain',
    '@ecs/protocol',
    '@ecs/storage',
  ],
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
  '@ecs/web': 'apps/web',
  '@ecs/server': 'apps/server',
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
}
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('package boundaries passed');
