/** Reproducible operator-local SH4→WASM JIT; distribution grant audit is unresolved. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pinnedSourceManifest,
  restoreZlibHeaderRename,
  snapshotPinnedSource,
  verifyPinnedSource,
} from './flycast-wasm-source.mjs';

const frontendPin = '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66';
const corePin = '2c48c0188a2afc158b02b6d1865d898756a03071';
const portPin = '16e9c7b4b7065a4bd42e7490e8aab3e9283d5415';
const repository = fileURLToPath(new URL('../..', import.meta.url));
const recipe = fileURLToPath(new URL('.', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const frontendFlags = [
  'LIBRETRO=flycast_wasm',
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
function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
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
if (process.argv.length !== 6)
  throw new Error(
    'Usage: node build-flycast-wasm.mjs FRONTEND_CHECKOUT FLYCAST_CHECKOUT PORT_CHECKOUT NEW_PLUGIN_DIRECTORY',
  );
const [frontendInput, coreInput, portInput, output] = process.argv
  .slice(2)
  .map((path) => resolve(path));
for (const path of [frontendInput, coreInput, portInput, output, tmpdir()]) {
  const actual = existsSync(path)
    ? realpathSync(path)
    : join(realpathSync(dirname(path)), path.split(/[\\/]/).at(-1));
  const within = relative(repository, actual);
  if (within !== '..' && !within.startsWith('../') && !isAbsolute(within))
    throw new Error('Build outside this repository');
}
if (existsSync(output)) throw new Error('Output must be new');
for (const [path, pin] of [
  [frontendInput, frontendPin],
  [coreInput, corePin],
  [portInput, portPin],
]) {
  if (run('git', ['rev-parse', 'HEAD'], path, true) !== pin)
    throw new Error(`Source pin mismatch: ${path}`);
}
if (!/^emcc .* 3\.1\.46\b/m.test(run('emcc', ['--version'], frontendInput, true)))
  throw new Error('Activate SDK 3.1.46');
// A private committed snapshot owns every mutation and all disposable build output.
const staging = mkdtempSync(join(tmpdir(), 'ecs-flycast-build-'));
const frontend = join(staging, 'frontend'),
  core = join(staging, 'core'),
  port = join(staging, 'port');
const coreModules = ['core/deps/asio', 'core/deps/libchdr', 'core/deps/tinygettext'];
snapshotPinnedSource(frontendInput, frontend, frontendPin);
snapshotPinnedSource(coreInput, core, corePin, coreModules);
snapshotPinnedSource(portInput, port, portPin);
const build = join(staging, 'build');
const upstreamPatch = join(port, 'patches/wasm-jit-phase1-modified.patch');
const ecsPatch = join(recipe, 'flycast-wasm-ecs.patch');
const patches = {
  upstream: digest(readFileSync(upstreamPatch)),
  ecs: digest(readFileSync(ecsPatch)),
};
const jitInputs = readdirSync(join(port, 'patches')).filter(
  (name) => name.endsWith('.h') || name === 'rec_wasm.cpp',
);
const sourceFingerprint = () =>
  digest(
    JSON.stringify({
      diff: run(
        'git',
        [
          'diff',
          '--full-index',
          '--no-renames',
          '--no-color',
          '--ignore-submodules=all',
          '--no-ext-diff',
          '--no-textconv',
          'HEAD',
        ],
        core,
        true,
      ),
      jit: jitInputs.map((name) => [name, digest(readFileSync(join(core, 'core/rec-wasm', name)))]),
    }),
  );
// The pinned port patch is LF text against one historical CRLF source file.
run('git', ['-c', 'core.autocrlf=input', 'apply', upstreamPatch], core);
mkdirSync(join(core, 'core/rec-wasm'), { recursive: true });
for (const name of jitInputs)
  copyFileSync(join(port, 'patches', name), join(core, 'core/rec-wasm', name));
run('git', ['apply', ecsPatch], core);
const patchedSourceSha256 = sourceFingerprint();
function verifyBuildSources() {
  verifyPinnedSource(frontend, frontendPin);
  verifyPinnedSource(port, portPin);
  verifyPinnedSource(core, corePin, true, coreModules);
  if (sourceFingerprint() !== patchedSourceSha256)
    throw new Error('Patched source changed during build');
}
verifyBuildSources();
run(
  'emcmake',
  [
    'cmake',
    '-S',
    core,
    '-B',
    build,
    '-G',
    'Ninja',
    '-DARCHITECTURE=wasm32',
    '-DCMAKE_OSX_ARCHITECTURES=',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DLIBRETRO=ON',
    '-DUSE_GLES=ON',
    '-DUSE_HOST_LIBZIP=OFF',
    '-DCMAKE_C_FLAGS=-DJIT_PROD_BUILD=1 -DFLY_RELEASE_BUILD=1',
    '-DCMAKE_CXX_FLAGS=-DJIT_PROD_BUILD=1 -DFLY_RELEASE_BUILD=1',
  ],
  core,
);
run('cmake', ['--build', build, '-j2'], core);
restoreZlibHeaderRename(core);
verifyBuildSources();
run(
  'emcc',
  ['-O3', '-c', join(recipe, 'flycast-wasm-compat.c'), '-o', join(build, 'ecs-flycast-compat.o')],
  core,
);
// Make does not invalidate objects when HAVE_OPENGLES3 or other flags change.
run('emmake', ['make', '-f', 'Makefile.emscripten', 'clean', ...frontendFlags], frontend);
copyFileSync(
  join(build, 'libflycast_libretro_emscripten.a'),
  join(frontend, 'libretro_emscripten.bc'),
);
// The frontend supplies libretro-common's file paths; retain the core's larger GLES table.
run('emar', ['d', join(frontend, 'libretro_emscripten.bc'), 'file_path.c.o'], frontend);
run(
  'emmake',
  [
    'make',
    '-j2',
    '-f',
    'Makefile.emscripten',
    '-f',
    join(recipe, 'flycast-wasm-link.mk'),
    ...frontendFlags,
    `ECS_FLYCAST_BUILD=${build}`,
  ],
  frontend,
);
verifyBuildSources();
mkdirSync(output);
const artifact = (source, file) => {
  const bytes = readFileSync(join(frontend, source));
  writeFileSync(join(output, file), bytes, { flag: 'wx' });
  return { file, sha256: digest(bytes) };
};
const manifest = {
  id: 'org.flycast.wasm-jit',
  name: 'Flycast (experimental WASM JIT)',
  kind: 'player',
  version: '1.0.0',
  engine: 'ecs.plugin/1',
  apps: ['org.provenance-emu.provenance'],
  player: {
    systems: ['com.provenance.dreamcast'],
    module: 'core.wasm',
    web: {
      profileVersion: 1,
      runtime: 'retroarch-emscripten-esm',
      filesystem: 'memfs',
      threaded: false,
      saveCompletion: 'none',
      contentExtensions: ['chd', 'cdi', 'elf', 'zip'],
      maxContentBytes: 536870912,
      buildVersion: 'Flycast2c48c018/SH4-WASM16e9c7b4/RetroArch4d4bfc0f/emcc3.1.46',
      loader: artifact('flycast_wasm_libretro.js', 'loader.js'),
      wasm: artifact('flycast_wasm_libretro.wasm', 'core.wasm'),
      assets: [],
    },
  },
};
writeFileSync(join(output, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const receipt = {
  frontendPin,
  corePin,
  portPin,
  sdk: '3.1.46',
  sdkCommit: '19607820c447a13fd8d0b7680c56148427d6e1b8',
  frontendFlags,
  recipeInputs: Object.fromEntries(
    [
      'build-flycast-wasm.mjs',
      'flycast-wasm-source.mjs',
      'flycast-wasm-link.mk',
      'flycast-wasm-compat.c',
    ].map((name) => [name, digest(readFileSync(join(recipe, name)))]),
  ),
  patches,
  patchedSourceSha256,
  staging,
  coreModules,
  gitlinks: pinnedSourceManifest(core),
  distribution:
    'Operator-local only: upstream Flycast includes GPL-2.0-or-later grants; full port/combined GPL-3.0 frontend grant audit unresolved. Do not publish this binary.',
  diagnostics: [
    '_ecs_jit_executor_mode() === 6',
    '_ecs_jit_executed_blocks() counts successful dynamic WASM dispatches',
    '_fly_ram_ptr(), _fly_vram_ptr(), _fly_frame_count()',
  ],
  limits:
    'Experimental JIT. No threads, bundled firmware/content, linked cabinets, WinCE/MMU acceptance, synchronized saves, or game compatibility claim.',
  manifest,
};
writeFileSync(`${output}.build.json`, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output, receipt: `${output}.build.json` }));
