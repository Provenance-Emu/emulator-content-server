/** Build operator assets from external pinned checkouts with an active SDK 3.1.46. */
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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotSource } from './source.mjs';

const frontendCommit = '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66';
const coreCommit = 'ac0d00a7fc01166f84c7bac01d1084ebfd2b865e';
const patchSha256 = 'ffc78048f23214a2aaccd84e7c8e443edfce06a194aa501818dcb11923738f21';
const patchPath = fileURLToPath(new URL('./retroarch-save-files.patch', import.meta.url));
const repository = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 3)
  throw new Error(
    'Usage: node scripts/browser-core/build.mjs FRONTEND_CHECKOUT CORE_CHECKOUT NEW_OPERATOR_DIRECTORY (activate Emscripten 3.1.46 first)',
  );
const [frontend, core, output] = args.map((argument) => resolve(argument));
for (const directory of [frontend, core, output]) {
  const path = existsSync(directory)
    ? realpathSync(directory)
    : join(realpathSync(dirname(directory)), directory.split(/[\\/]/).at(-1));
  const within = relative(repository, path);
  if (
    within !== '..' &&
    !within.startsWith('../') &&
    !within.startsWith('..\\') &&
    !isAbsolute(within)
  )
    throw new Error('Checkouts and operator output must be outside this repository');
}
if (existsSync(output) && readdirSync(output).length)
  throw new Error('Operator output directory must be new or empty');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const patch = readFileSync(patchPath);
if (digest(patch) !== patchSha256) throw new Error('Browser core patch digest mismatch');
function run(command, argv, cwd, capture = false) {
  const result = spawnSync(command, argv, {
    cwd,
    env: { ...process.env, BINARYEN_CORES: '2', EMCC_CORES: '2' },
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed (${result.error?.message ?? result.status})`);
  return result.stdout?.trim() ?? '';
}
if (!/^emcc .* 3\.1\.46\b/m.test(run('emcc', ['--version'], frontend, true)))
  throw new Error('Activate the exact Emscripten SDK 3.1.46');
for (const [checkout, commit] of [
  [frontend, frontendCommit],
  [core, coreCommit],
]) {
  if (run('git', ['rev-parse', 'HEAD'], checkout, true) !== commit)
    throw new Error('Source checkout does not match the pinned upstream base commit');
  if (run('git', ['diff', '--cached', '--name-only'], checkout, true))
    throw new Error('Source checkout has staged changes');
}
if (run('git', ['diff', '--name-only'], core, true))
  throw new Error('FCEUmm checkout must have no tracked changes');
const delta = run('git', ['diff', '--no-ext-diff', 'HEAD', '--'], frontend, true);
if (delta && `${delta}\n` !== patch.toString())
  throw new Error('RetroArch checkout contains changes other than the required patch');
const buildRoot = mkdtempSync(join(tmpdir(), 'ecs-browser-build-'));
try {
  const buildFrontend = join(buildRoot, 'frontend');
  const buildCore = join(buildRoot, 'core');
  snapshotSource(frontend, buildFrontend, frontendCommit);
  snapshotSource(core, buildCore, coreCommit);
  run('git', ['apply', '--check', patchPath], buildFrontend);
  run('git', ['apply', patchPath], buildFrontend);
  run('emmake', ['make', '-j2', '-f', 'Makefile.libretro', 'platform=emscripten'], buildCore);
  copyFileSync(
    join(buildCore, 'fceumm_libretro_emscripten.bc'),
    join(buildFrontend, 'libretro_emscripten.bc'),
  );
  run(
    'emmake',
    [
      'make',
      '-j2',
      '-f',
      'Makefile.emscripten',
      'LIBRETRO=fceumm',
      'HAVE_THREADS=0',
      'PROXY_TO_PTHREAD=0',
      'HAVE_WASMFS=0',
      'HAVE_EXTRA_WASMFS=0',
      'HAVE_AUDIOWORKLET=0',
      'JSPI=0',
      'FS_DEBUG=0',
    ],
    buildFrontend,
  );
  mkdirSync(output, { recursive: true });
  const artifact = (file) => {
    copyFileSync(join(buildFrontend, file), join(output, file));
    return { file, sha256: digest(readFileSync(join(output, file))) };
  };
  const descriptor = {
    version: 1,
    id: 'fceumm',
    name: 'Pinned FCEUmm with SAVE_FILES correction',
    systems: ['com.provenance.nes'],
    runtime: 'retroarch-emscripten-esm',
    threaded: false,
    filesystem: 'memfs',
    saveCompletion: 'command-reply-v1',
    frontendCommit,
    coreCommit,
    emscriptenVersion: '3.1.46',
    contentExtension: 'nes',
    maxContentBytes: 64 * 1024 * 1024,
    loader: artifact('fceumm_libretro.js'),
    wasm: artifact('fceumm_libretro.wasm'),
  };
  writeFileSync(join(output, 'core.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        frontendBase: frontendCommit,
        coreCommit,
        emscriptenVersion: '3.1.46',
        patchSha256,
        loader: descriptor.loader,
        wasm: descriptor.wasm,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(buildRoot, { recursive: true, force: true });
}
