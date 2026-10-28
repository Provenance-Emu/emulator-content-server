import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parsePlayerPackage } from '@ecs/plugins';
import type { TrustedPlayer } from '../src/player-catalog.js';
import { downloadCatalogPlayer } from '../src/player-download.js';

const loader = Buffer.from('export default async()=>({FS:{},callMain(){}});');
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const files = [loader, wasm];
function entry(): TrustedPlayer & { upstream: NonNullable<TrustedPlayer['upstream']> } {
  return {
    id: 'org.example.upstream',
    name: 'Original generated player',
    systems: ['com.provenance.gb'],
    description: 'Generated fixture',
    available: true,
    reason: null,
    downloadBytes: loader.length + wasm.length,
    url: null,
    sha256: null,
    upstream: {
      manifest: {
        id: 'org.example.upstream',
        name: 'Original generated player',
        kind: 'player',
        version: '1',
        engine: 'ecs.plugin/1',
        apps: ['org.example.test'],
        player: {
          systems: ['com.provenance.gb'],
          module: 'core.wasm',
          web: {
            profileVersion: 1,
            runtime: 'retroarch-emscripten-esm',
            filesystem: 'memfs',
            threaded: false,
            saveCompletion: 'none',
            contentExtensions: ['gb'],
            maxContentBytes: 1024,
            buildVersion: 'generated',
            loader: { file: 'loader.js', sha256: hash(loader) },
            wasm: { file: 'core.wasm', sha256: hash(wasm) },
            assets: [],
          },
        },
      },
      resources: files.map((b, i) => ({
        url: `https://web.libretro.com/generated_libretro.${i ? 'wasm' : 'js'}`,
        file: i ? 'core.wasm' : 'loader.js',
        sha256: hash(b),
        sizeBytes: b.length,
      })),
    },
  };
}

test('pinned upstream resources assemble into a verified installable package', async (t) => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(options.redirect, 'manual');
    const expected = entry().upstream.resources[count];
    const body = files[count++];
    assert.ok(expected);
    assert.ok(body);
    assert.equal(url, expected.url);
    return new Response(body);
  });
  const pkg = parsePlayerPackage(await downloadCatalogPlayer(entry()));
  assert.equal(count, 2);
  assert.equal(pkg.manifest.id, entry().id);
  assert.deepEqual(pkg.files.get('core.wasm'), wasm);
});
for (const mode of [
  'hash',
  'truncated',
  'oversize',
  'redirect-host',
  'redirect-http',
  'private-url',
  'mismatched-id',
] as const) {
  test(`upstream install rejects ${mode} before accepting software`, async (t) => {
    const core = entry();
    const first = core.upstream.resources[0];
    assert.ok(first);
    if (mode === 'private-url') first.url = 'https://127.0.0.1/core.js';
    if (mode === 'mismatched-id') core.upstream.manifest.id = 'org.example.other';
    let fetched = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      fetched++;
      if (mode.startsWith('redirect'))
        return new Response(null, {
          status: 302,
          headers: {
            location:
              mode === 'redirect-http'
                ? 'http://web.libretro.com/generated_libretro.js'
                : 'https://example.com/core.js',
          },
        });
      let body: Uint8Array = loader;
      if (mode === 'hash') body = Buffer.alloc(loader.length);
      if (mode === 'truncated') body = loader.subarray(1);
      if (mode === 'oversize') body = Buffer.concat([loader, Buffer.from([0])]);
      return new Response(body);
    });
    await assert.rejects(downloadCatalogPlayer(core));
    if (mode === 'private-url' || mode === 'mismatched-id') assert.equal(fetched, 0);
    else assert.equal(fetched, 1);
  });
}
