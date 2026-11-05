/** Pinned software-rendered, single-thread ProSystem build in isolated temporary checkouts. */
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
const corePin = '8a88014287c7a01cd568067e5a557d0a2b2a051f';
const repository = fileURLToPath(new URL('../..', import.meta.url));
const coreFlags = ['platform=emscripten', 'CC=emcc', 'CXX=em++', 'AR=emar'];
const frontendFlags = [
  'LIBRETRO=prosystem',
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
    'Usage: node build-prosystem.mjs FRONTEND_CHECKOUT CORE_CHECKOUT NEW_PLUGIN_DIRECTORY',
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
const build = mkdtempSync(join(tmpdir(), 'ecs-prosystem-profile-'));
try {
  const f = join(build, 'frontend'),
    c = join(build, 'prosystem');
  snapshotSource(frontend, f, frontendPin);
  snapshotSource(core, c, corePin);
  run('emmake', ['make', '-j2', ...coreFlags], c);
  copyFileSync(join(c, 'prosystem_libretro_emscripten.bc'), join(f, 'libretro_emscripten.bc'));
  run('emmake', ['make', '-j2', '-f', 'Makefile.emscripten', ...frontendFlags], f);
  mkdirSync(output);
  const artifact = (source, file) => {
    const bytes = readFileSync(join(f, source));
    writeFileSync(join(output, file), bytes, { flag: 'wx' });
    return { file, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const manifest = {
    id: 'org.libretro.prosystem',
    name: 'ProSystem (software renderer)',
    kind: 'player',
    version: '1.0.0',
    engine: 'ecs.plugin/1',
    apps: ['org.provenance-emu.provenance'],
    player: {
      systems: ['com.provenance.7800'],
      module: 'core.wasm',
      web: {
        profileVersion: 1,
        runtime: 'retroarch-emscripten-esm',
        filesystem: 'memfs',
        threaded: false,
        saveCompletion: 'none',
        contentExtensions: ['a78', 'bin'],
        maxContentBytes: 1048576,
        buildVersion: 'RetroArch 4d4bfc0f / ProSystem 8a880142 / emcc 3.1.46',
        loader: artifact('prosystem_libretro.js', 'loader.js'),
        wasm: artifact('prosystem_libretro.wasm', 'core.wasm'),
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
        coreSource: 'https://github.com/libretro/prosystem-libretro',
        sdk: '3.1.46',
        sdkCommit: '19607820c447a13fd8d0b7680c56148427d6e1b8',
        coreFlags,
        frontendFlags,
        patches: [],
        targetDefaults:
          'Software-rendered single-thread Atari 7800; optional BIOS is not supplied.',
        licenses: [
          'RetroArch GPL-3.0-or-later',
          'ProSystem GPL-2.0-or-later; retain License.txt and all dependency notices.',
        ],
        limits:
          'Original-program acceptance only; no commercial compatibility claim, synchronized saves or firmware supplied. Retain complete pinned frontend/core corresponding source and dependency notices for distribution.',
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
