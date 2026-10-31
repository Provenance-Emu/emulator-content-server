import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseWorkflowPackage } from '../src/workflows/package.js';

function bundle(
  overrides: Record<string, unknown> = {},
  fileOverrides: Record<string, unknown> = {},
) {
  const content = Buffer.from('export default { start() {} };');
  const header = Buffer.from(
    JSON.stringify({
      manifest: {
        id: 'org.example.translator',
        name: 'Generated translator',
        version: '1.0.0',
        engine: 'ecs.plugin/2',
        hostApi: '^1.0.0',
        kind: 'translator',
        entry: 'translator.mjs',
        provides: [{ capability: 'text.generate', major: 1 }],
      },
      files: [
        {
          name: 'translator.mjs',
          size: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
          ...fileOverrides,
        },
      ],
      ...overrides,
    }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, content]);
}

test('workflow packages validate exact contents without evaluating a module', () => {
  const parsed = parseWorkflowPackage(bundle());
  assert.equal(parsed.manifest.engine, 'ecs.plugin/2');
  assert.equal(parsed.files.get('translator.mjs')?.toString(), 'export default { start() {} };');
});

test('workflow packages reject traversal, links, bad hashes, missing bytes and trailing data', () => {
  for (const name of [
    '../outside.mjs',
    '/outside.mjs',
    'C:/outside.mjs',
    'sub\\outside.mjs',
    'plugin.json',
  ])
    assert.throws(() => parseWorkflowPackage(bundle({}, { name })));
  assert.throws(() => parseWorkflowPackage(bundle({}, { type: 'symlink' })));
  assert.throws(() => parseWorkflowPackage(bundle({}, { sha256: '0'.repeat(64) })));
  assert.throws(() => parseWorkflowPackage(bundle({}, { size: 17 * 1024 * 1024 })));
  assert.throws(() => parseWorkflowPackage(Buffer.concat([bundle(), Buffer.from([0])])));
  assert.throws(() => parseWorkflowPackage(bundle().subarray(0, -1)));
  assert.throws(() => parseWorkflowPackage(Buffer.from([0, 64, 0, 1])));
});

function multipleFiles(names: string[]): Buffer {
  const base = bundle();
  const manifest = JSON.parse(base.subarray(4, 4 + base.readUInt32BE(0)).toString('utf8')).manifest;
  const content = Buffer.from('x');
  const header = Buffer.from(
    JSON.stringify({
      manifest,
      files: names.map((name) => ({
        name,
        size: 1,
        sha256: createHash('sha256').update(content).digest('hex'),
      })),
    }),
  );
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.length);
  return Buffer.concat([size, header, ...names.map(() => content)]);
}

test('workflow packages reject duplicate and case-colliding paths before extraction', () => {
  assert.throws(() => parseWorkflowPackage(multipleFiles(['translator.mjs', 'translator.mjs'])));
  assert.throws(() => parseWorkflowPackage(multipleFiles(['translator.mjs', 'TRANSLATOR.MJS'])));
});

test('extra resources cannot collide with the manifest or use cross-platform special paths', () => {
  for (const name of [
    'plugin.json/nested.mjs',
    'assets/file:stream',
    'assets/NUL.mjs',
    'assets/trailing.',
    '../escape.mjs',
  ]) {
    assert.throws(() => parseWorkflowPackage(multipleFiles(['translator.mjs', name])), name);
  }
});
