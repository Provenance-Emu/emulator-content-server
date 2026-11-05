import { createHash } from 'node:crypto';
import type { TrustedPlayer } from '../src/player-catalog.js';

export function upstreamFixture(revision = 1) {
  const loader = Buffer.from(`export default async()=>({FS:{},callMain(){}}); // ${revision}`);
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 2, 1, revision]);
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const files = [loader, wasm];
  const entry: TrustedPlayer = {
    id: 'org.example.upstream',
    name: 'Generated player',
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
        name: 'Generated player',
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
            buildVersion: `generated-${revision}`,
            loader: { file: 'loader.js', sha256: hash(loader) },
            wasm: { file: 'core.wasm', sha256: hash(wasm) },
            assets: [],
          },
        },
      },
      resources: files.map((bytes, i) => ({
        url: `https://web.libretro.com/generated_libretro.${i ? 'wasm' : 'js'}`,
        file: i ? 'core.wasm' : 'loader.js',
        sha256: hash(bytes),
        sizeBytes: bytes.length,
      })),
    },
  };
  return { entry, files, loader, wasm };
}
