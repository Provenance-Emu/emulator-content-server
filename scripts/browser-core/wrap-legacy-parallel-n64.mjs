/** Operator-local adapter for the pinned official legacy ParaLLEl N64 web core. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const legacyN64Hashes = Object.freeze({
  loader: 'fab15b23ab3946694d7ab7b72c6522c7565996534840a435866c1f7c156446cc',
  wasm: 'c88916cb9bcae5c45da12d0180133e66b5335f7a4c56fa777fe8c7d82ffa1c32',
});
const repository = fileURLToPath(new URL('../..', import.meta.url));
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Retain the upstream program verbatim, scoped around the same lexical Module and FS. */
export function wrapLegacyN64(source) {
  if (sha256(source) !== legacyN64Hashes.loader)
    throw Error('Unexpected official N64 loader digest');
  return `export default function(options) {\nreturn new Promise(function(resolve,reject) {\nvar Module=Object.assign({},options,{ENVIRONMENT:'WEB',locateFile:function(name){return options.locateFile(name==='parallel_n64_libretro.wast'||name==='parallel_n64_libretro.temp.asm.js'?'parallel_n64_libretro.wasm':name);},onRuntimeInitialized:function(){Module.FS=FS;resolve(Module);},onAbort:function(reason){reject(new Error(String(reason)));}});\n${source.toString()}\n});\n}\n`;
}
export function writeLegacyN64Profile(loaderPath, wasmPath, outputPath) {
  const loader = readFileSync(loaderPath),
    wasm = readFileSync(wasmPath);
  if (sha256(wasm) !== legacyN64Hashes.wasm) throw Error('Unexpected official N64 WASM digest');
  const output = resolve(outputPath),
    actual = join(realpathSync(dirname(output)), output.split(/[\\/]/).at(-1));
  const within = relative(repository, actual);
  if (within !== '..' && !within.startsWith('../') && !isAbsolute(within))
    throw Error('Write profiles outside the repository');
  if (existsSync(output)) throw Error('Profile output must be new');
  const wrapped = wrapLegacyN64(loader);
  mkdirSync(output);
  writeFileSync(join(output, 'loader.js'), wrapped, { flag: 'wx' });
  writeFileSync(join(output, 'core.wasm'), wasm, { flag: 'wx' });
  const manifest = {
    id: 'org.libretro.parallel-n64',
    name: 'ParaLLEl N64 (unverified legacy diagnostic)',
    kind: 'player',
    version: '2019-local-adapter',
    engine: 'ecs.plugin/1',
    apps: ['org.provenance-emu.provenance'],
    player: {
      systems: ['com.provenance.n64'],
      module: 'core.wasm',
      web: {
        profileVersion: 1,
        runtime: 'retroarch-emscripten-esm',
        filesystem: 'memfs',
        threaded: false,
        saveCompletion: 'none',
        contentExtensions: ['z64', 'n64', 'v64'],
        maxContentBytes: 67108864,
        buildVersion:
          'Official web.libretro.com legacy ParaLLEl N64 / pinned SHA-256 / local ES module adapter',
        loader: { file: 'loader.js', sha256: sha256(wrapped) },
        wasm: { file: 'core.wasm', sha256: sha256(wasm) },
        assets: [],
      },
    },
  };
  writeFileSync(join(output, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  writeFileSync(
    `${output}.receipt.json`,
    `${JSON.stringify(
      {
        diagnosticOnly: true,
        acceptance:
          'Blocked: env._gl_glsl_backend global import is supplied as a missing-function stub by the official loader.',
        source: 'https://web.libretro.com/parallel_n64_libretro.js',
        wasmSource: 'https://web.libretro.com/parallel_n64_libretro.wasm',
        upstreamHashes: legacyN64Hashes,
        transform:
          'Unchanged upstream JavaScript in a lexical Module/FS promise factory. Legacy eager .wast/asm fallback location queries resolve to the declared WASM URL; no undeclared resources, security changes, or emulator stubs.',
        distribution:
          'Operator-local experiment; source/license provenance must be established before publication.',
        manifest,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  );
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5)
    throw Error(
      'Usage: node wrap-legacy-parallel-n64.mjs OFFICIAL_JS OFFICIAL_WASM NEW_EXTERNAL_PROFILE',
    );
  console.log(JSON.stringify(writeLegacyN64Profile(...process.argv.slice(2)), null, 2));
}
