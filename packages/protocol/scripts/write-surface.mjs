import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSurface, loadOpenApi } from '../dist/src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const target = join(root, 'docs', 'protocol', 'v1-surface.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(extractSurface(loadOpenApi()), null, 2)}\n`);
console.log(`wrote ${target}`);
