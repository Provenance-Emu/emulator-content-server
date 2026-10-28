import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parsePlayerPackage } from '../src/player-package.js';

function packet(name = 'loader.js') {
  const loader = Buffer.from('generated loader'),
    wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const manifest = {
    id: 'org.example.test',
    name: 'Test',
    kind: 'player',
    version: '1',
    engine: 'ecs.plugin/1',
    apps: ['org.example.test'],
    player: {
      module: 'core.wasm',
      systems: ['com.provenance.nes'],
      web: {
        profileVersion: 1,
        runtime: 'emscripten-esm-v1',
        filesystem: 'memfs',
        threaded: false,
        saveCompletion: 'none',
        contentExtensions: ['nes'],
        maxContentBytes: 1024,
        buildVersion: 'generated',
        loader: { file: 'loader.js', sha256: hash(loader) },
        wasm: { file: 'core.wasm', sha256: hash(wasm) },
        assets: [],
      },
    },
  };
  const header = Buffer.from(
    JSON.stringify({
      manifest,
      files: [
        { name, size: loader.length },
        { name: 'core.wasm', size: wasm.length },
      ],
    }),
  );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length);
  return Buffer.concat([prefix, header, loader, wasm]);
}
test('player package accepts exact verified resources and rejects traversal, trailing, truncated and altered bytes', () => {
  assert.equal(parsePlayerPackage(packet()).files.size, 2);
  assert.throws(() => parsePlayerPackage(packet('../loader.js')), /resource/);
  const p = packet();
  assert.throws(() => parsePlayerPackage(p.subarray(0, p.length - 1)), /incomplete/);
  assert.throws(() => parsePlayerPackage(Buffer.concat([p, Buffer.from([1])])), /Unexpected/);
  p[p.length - 1] = 1;
  assert.throws(() => parsePlayerPackage(p), /checksum/);
});
