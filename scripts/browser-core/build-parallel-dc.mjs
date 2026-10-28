/** Operator-local experimental build. GPL upgrade compatibility remains unconfirmed: do not publish. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendPin = '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66';
const corePin = '1a678828f17f5f682a808a1fdc2103c913b0231a';
const repository = fileURLToPath(new URL('../..', import.meta.url));
const recipe = fileURLToPath(new URL('.', import.meta.url));
const coreFlags = [
  'platform=emscripten',
  'CC=emcc',
  'CXX=em++',
  'AR=emar',
  'STATIC_LINKING=1',
  'NO_REC=1',
  'NO_THREADS=1',
  'NO_EXCEPTIONS=1',
  'NO_NVMEM=1',
  'HAVE_GENERIC_JIT=0',
  'HAVE_OPENMP=0',
  'HAVE_VULKAN=0',
  'SINGLE_THREAD=1',
];
const frontendFlags = [
  'LIBRETRO=parallel_dc',
  'HAVE_OPENGLES3=1',
  'HAVE_THREADS=0',
  'PROXY_TO_PTHREAD=0',
  'HAVE_WASMFS=0',
  'HAVE_EXTRA_WASMFS=0',
  'HAVE_AUDIOWORKLET=0',
  'JSPI=0',
  'FS_DEBUG=0',
  'HAVE_7ZIP=0',
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: capture ? 'pipe' : 'inherit',
    env: {
      ...process.env,
      BINARYEN_CORES: '2',
      EMCC_CORES: '2',
      DEVELOPER_DIR: '/Library/Developer/CommandLineTools',
    },
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${result.stderr ?? result.error?.message ?? result.status}`,
    );
  return result.stdout?.trim() ?? '';
}
if (process.argv.length !== 5)
  throw new Error(
    'Usage: node build-parallel-dc.mjs FRONTEND_CHECKOUT CORE_CHECKOUT NEW_PLUGIN_DIRECTORY',
  );
const [frontend, core, output] = process.argv.slice(2).map((path) => resolve(path));
for (const path of [frontend, core, output]) {
  const actual = existsSync(path)
    ? realpathSync(path)
    : join(realpathSync(dirname(path)), path.split(/[\\/]/).at(-1));
  const within = relative(repository, actual);
  if (within !== '..' && !within.startsWith('../') && !isAbsolute(within))
    throw new Error('Build outside this repository');
}
if (existsSync(output)) throw new Error('Output must be new');
for (const [path, pin] of [
  [frontend, frontendPin],
  [core, corePin],
])
  if (run('git', ['rev-parse', 'HEAD'], path, true) !== pin) throw new Error('Source pin mismatch');
if (run('git', ['diff', '--name-only', 'HEAD'], frontend, true))
  throw new Error('Frontend must be clean');
if (!/^emcc .* 3\.1\.46\b/m.test(run('emcc', ['--version'], frontend, true)))
  throw new Error('Activate SDK 3.1.46');
const patch = join(recipe, 'parallel-dc-emscripten.patch');
const diff = run('git', ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'], core, true);
if (!diff) run('git', ['apply', '--check', patch], core);
else if (diff !== readFileSync(patch, 'utf8').trim())
  throw new Error('Core contains changes other than this recipe patch');
if (!diff) run('git', ['apply', patch], core);
run('emmake', ['make', 'clean', ...coreFlags], core);
run('emmake', ['make', '-j2', ...coreFlags], core);
run('emmake', ['make', '-f', 'Makefile.emscripten', 'clean', ...frontendFlags], frontend);
copyFileSync(
  join(core, 'parallel_dc_libretro_emscripten.a'),
  join(frontend, 'libretro_emscripten.bc'),
);
run(
  'emmake',
  [
    'make',
    '-j2',
    '-f',
    'Makefile.emscripten',
    '-f',
    join(recipe, 'parallel-dc-link.mk'),
    ...frontendFlags,
  ],
  frontend,
);
mkdirSync(output);
const artifact = (source, file) => {
  const bytes = readFileSync(join(frontend, source));
  writeFileSync(join(output, file), bytes, { flag: 'wx' });
  return { file, sha256: digest(bytes) };
};
const manifest = {
  id: 'org.libretro.parallel-dc',
  name: 'paraLLEl DC (experimental interpreter)',
  kind: 'player',
  version: '1.0.0',
  engine: 'ecs.plugin/1',
  apps: ['org.provenance-emu.provenance'],
  player: {
    systems: [
      'com.provenance.dreamcast',
      'com.provenance.naomi',
      'com.provenance.naomi2',
      'com.provenance.atomiswave',
    ],
    module: 'core.wasm',
    web: {
      profileVersion: 1,
      runtime: 'retroarch-emscripten-esm',
      filesystem: 'memfs',
      threaded: false,
      saveCompletion: 'none',
      contentExtensions: ['chd', 'cdi', 'elf', 'bin', 'dat', 'zip'],
      maxContentBytes: 536870912,
      buildVersion: 'RetroArch 4d4bfc0f / paraLLEl DC 1a678828 experimental / emcc 3.1.46',
      loader: artifact('parallel_dc_libretro.js', 'loader.js'),
      wasm: artifact('parallel_dc_libretro.wasm', 'core.wasm'),
      assets: [],
    },
  },
};
writeFileSync(join(output, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const receipt = {
  frontendPin,
  corePin,
  sdk: '3.1.46',
  sdkCommit: '19607820c447a13fd8d0b7680c56148427d6e1b8',
  coreFlags,
  frontendFlags,
  patchSha256: digest(readFileSync(patch)),
  distribution:
    'Operator-local only; RetroArch GPL-3.0-or-later / core GPL-2.0 upgrade grant remains unconfirmed.',
  limits:
    'Interpreter only. Host SH4 FP rounding/subnormal semantics differ. No threads, linked cabinets, custom textures, CHD read-ahead, synchronized saves or companion-file layouts. Atomiswave requires user-provided /ecs/system/dc/awbios.zip (bios0.ic23). No firmware included.',
  manifest,
};
writeFileSync(`${output}.build.json`, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output, receipt: `${output}.build.json`, manifest }, null, 2));
