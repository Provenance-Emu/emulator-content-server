import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as recipe from './n64-source.mjs';

const sdk = join(
  process.env.ECS_N64_EMSDK ?? join(homedir(), '.cache/ecs-web-player-build-20261028/emsdk'),
  'upstream/emscripten',
);
const forbidden =
  /\bimport\b\s*(?!\s*\.)|\b(?:Worker|SharedWorker)\s*\(|\b(?:audioWorklet|paintWorklet)\b|\bimportScripts\s*\(/;

test('pinned SDK AST printer removes comments while preserving the ES module interface', {
  skip: !existsSync(join(sdk, 'tools/acorn-optimizer.js')),
}, async () => {
  assert.equal(typeof recipe.minifyN64Loader, 'function', 'N64 loader minimization is required');
  const root = mkdtempSync(join(tmpdir(), 'ecs-n64-loader-'));
  try {
    const file = join(root, 'loader.mjs');
    writeFileSync(
      file,
      '// We import and export values.\nexport default function(options) { return { value: options.value + 1, url: import.meta.url }; }\n',
    );
    const bytes = recipe.minifyN64Loader(file, sdk);
    assert.equal(forbidden.test(bytes.toString()), false);
    const module = await import(`data:text/javascript;base64,${bytes.toString('base64')}`);
    assert.equal(module.default({ value: 41 }).value, 42);
    assert.match(module.default({ value: 0 }).url, /^data:text\/javascript/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('minimization rejects actual imports and worker capabilities', {
  skip: !existsSync(join(sdk, 'tools/acorn-optimizer.js')),
}, () => {
  assert.equal(typeof recipe.minifyN64Loader, 'function', 'N64 loader minimization is required');
  const root = mkdtempSync(join(tmpdir(), 'ecs-n64-loader-reject-'));
  try {
    const file = join(root, 'loader.mjs');
    for (const source of [
      'import "external"; export default 1;',
      'export default () => import("external");',
      'export default () => new Worker("external");',
    ]) {
      writeFileSync(file, source);
      assert.throws(() => recipe.minifyN64Loader(file, sdk), /unsupported loader capability/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
