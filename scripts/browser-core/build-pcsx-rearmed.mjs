/** Pinned software-rendered, single-thread PCSX ReARMed build in isolated temporary checkouts. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotSource } from './source.mjs';

const frontendPin = '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66';
const corePin = 'c8816799b50388e61cfe237fe2cdbb7d8175f20a';
const repository = fileURLToPath(new URL('../..', import.meta.url));
const coreFlags = [
  '-f',
  'Makefile.libretro',
  'platform=emscripten',
  'CC=emcc',
  'CXX=em++',
  'AR=emar',
  'NDRC_THREAD=0',
];
const frontendFlags = [
  'LIBRETRO=pcsx_rearmed',
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
  return result.stdout ?? '';
}
if (process.argv.length !== 5)
  throw new Error(
    'Usage: node build-pcsx-rearmed.mjs FRONTEND_CHECKOUT CORE_CHECKOUT NEW_PLUGIN_DIRECTORY',
  );
const [frontend, core, output] = process.argv.slice(2).map((path) => resolve(path));
for (const path of [frontend, core, output]) {
  const actual = existsSync(path)
    ? realpathSync(path)
    : join(realpathSync(dirname(path)), path.split(/[\\/]/).at(-1));
  const within = relative(repository, actual);
  if (within !== '..' && !within.startsWith('../') && !isAbsolute(within))
    throw new Error('Build outside the repository');
}
if (existsSync(output) || existsSync(`${output}.build.json`)) throw new Error('Output must be new');
if (!/^emcc .* 3\.1\.46\b/m.test(run('emcc', ['--version'], frontend, true)))
  throw new Error('Activate SDK 3.1.46');
const build = mkdtempSync(join(tmpdir(), 'ecs-pcsx-profile-'));
try {
  const f = join(build, 'frontend'),
    c = join(build, 'pcsx-rearmed');
  snapshotSource(frontend, f, frontendPin);
  snapshotSource(core, c, corePin);
  run('emmake', ['make', '-j2', ...coreFlags], c);
  copyFileSync(join(c, 'pcsx_rearmed_libretro_emscripten.bc'), join(f, 'libretro_emscripten.bc'));
  run('emmake', ['make', '-j2', '-f', 'Makefile.emscripten', ...frontendFlags], f);
  mkdirSync(output);
  const artifact = (source, file) => {
    const bytes = readFileSync(join(f, source));
    writeFileSync(join(output, file), bytes, { flag: 'wx' });
    return { file, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const manifest = {
    id: 'org.libretro.pcsx-rearmed',
    name: 'PCSX ReARMed (software renderer)',
    kind: 'player',
    version: '1.0.0',
    engine: 'ecs.plugin/1',
    apps: ['org.provenance-emu.provenance'],
    player: {
      systems: ['com.provenance.psx'],
      module: 'core.wasm',
      web: {
        profileVersion: 1,
        runtime: 'retroarch-emscripten-esm',
        filesystem: 'memfs',
        threaded: false,
        saveCompletion: 'none',
        contentExtensions: ['exe', 'chd', 'pbp', 'iso'],
        maxContentBytes: 536870912,
        buildVersion: 'RetroArch 4d4bfc0f / PCSX ReARMed c8816799 / emcc 3.1.46',
        loader: artifact('pcsx_rearmed_libretro.js', 'loader.js'),
        wasm: artifact('pcsx_rearmed_libretro.wasm', 'core.wasm'),
        assets: [],
      },
    },
  };
  writeFileSync(join(output, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    `${output}.build.json`,
    `${JSON.stringify(
      {
        frontendPin,
        corePin,
        frontendSource: 'https://github.com/libretro/RetroArch',
        coreSource: 'https://github.com/libretro/pcsx_rearmed',
        sdk: '3.1.46',
        sdkCommit: '19607820c447a13fd8d0b7680c56148427d6e1b8',
        coreFlags,
        frontendFlags,
        patches: [],
        targetDefaults:
          'NO_MMAP=1, USE_MINIZ=0, software SIMD GPU, no dynarec, USE_RTHREADS=0, USE_ASYNC_CDROM/GPU/SPU=0, no physical CDROM, no shared library modules.',
        licenses: [
          'RetroArch GPL-3.0-or-later',
          'PCSX core, HLE BIOS, selected software GPU and SPU headers grant GPL-2.0-or-later; retain COPYING and every dependency notice (including libchdr).',
        ],
        limits:
          'Single-file EXE/CHD/PBP/ISO only; no companion CUE/GDI/M3U/SBI files, disc-swap UI, synchronized saves, or commercial compatibility claim. Core falls back to HLE without a user-provided BIOS. No console firmware supplied. Retain complete corresponding source and dependency notices for distribution.',
        manifest,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify({ output, receipt: `${output}.build.json`, manifest }, null, 2));
} finally {
  rmSync(build, { recursive: true, force: true });
}
