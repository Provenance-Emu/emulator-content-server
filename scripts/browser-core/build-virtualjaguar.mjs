/** Build the pinned BIOS-free cartridge profile from external checkouts. SDK 3.1.46 required. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
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
import { makeVirtualJaguarBiosFree, virtualJaguarPin } from './virtualjaguar-bios-free.mjs';

const frontendPin = '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66';
const repository = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const flags = [
  'LIBRETRO=virtualjaguar',
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
    env: {
      ...process.env,
      BINARYEN_CORES: '2',
      EMCC_CORES: '2',
      DEVELOPER_DIR: '/Library/Developer/CommandLineTools',
    },
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${result.error?.message ?? result.stderr ?? result.status}`,
    );
  return result.stdout?.trim() ?? '';
}
if (process.argv.length !== 5)
  throw new Error(
    'Usage: node build-virtualjaguar.mjs FRONTEND_CHECKOUT CORE_CHECKOUT NEW_PLUGIN_DIRECTORY',
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
if (existsSync(output) || existsSync(`${output}.source.tar.gz`))
  throw new Error('Output must be new');
for (const [path, pin] of [
  [frontend, frontendPin],
  [core, virtualJaguarPin],
])
  if (run('git', ['rev-parse', 'HEAD'], path, true) !== pin) throw new Error('Source pin mismatch');
if (!/^emcc .* 3\.1\.46\b/m.test(run('emcc', ['--version'], frontend, true)))
  throw new Error('Activate SDK 3.1.46');
const build = mkdtempSync(join(tmpdir(), 'ecs-jaguar-profile-'));
try {
  const f = join(build, 'frontend'),
    c = join(build, 'virtualjaguar');
  snapshotSource(frontend, f, frontendPin);
  mkdirSync(c);
  // Copy only tracked build inputs; no ROM fixtures, operator ignored data, Git objects or artifacts.
  const files = run('git', ['ls-files', '-z'], core, true).split('\0').filter(Boolean);
  for (const file of files) {
    if (
      /^(?:test|site|app|dist|docker|\.github|\.agents|\.claude)\//.test(file) ||
      /\.(?:j64|jag|rom|abs|cof|bin|prg|cue|cdi|chd|nes|iso)$/i.test(file)
    )
      continue;
    const source = join(core, file),
      destination = join(c, file);
    if (!existsSync(source) || !lstatSync(source).isFile()) continue;
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    chmodSync(destination, lstatSync(source).mode & 0o777);
  }
  makeVirtualJaguarBiosFree(c, core);
  // Preserve the measured patched build identity in source archives without Git metadata.
  writeFileSync(join(c, 'scripts/build-id.sh'), "#!/bin/sh\nprintf 'ffea789-dirty\\n'\n");
  run('emmake', ['make', '-j2', 'platform=emscripten'], c);
  copyFileSync(join(c, 'virtualjaguar_libretro_emscripten.bc'), join(f, 'libretro_emscripten.bc'));
  run('emmake', ['make', '-j2', '-f', 'Makefile.emscripten', ...flags], f);
  mkdirSync(output);
  const artifact = (source, file) => {
    const bytes = readFileSync(join(f, source));
    writeFileSync(join(output, file), bytes, { flag: 'wx' });
    return { file, sha256: digest(bytes) };
  };
  const manifest = {
    id: 'org.libretro.virtualjaguar',
    name: 'Virtual Jaguar (BIOS-free cartridges)',
    kind: 'player',
    version: '1.0.0',
    engine: 'ecs.plugin/1',
    apps: ['org.provenance-emu.provenance'],
    player: {
      systems: ['com.provenance.jaguar'],
      module: 'core.wasm',
      web: {
        profileVersion: 1,
        runtime: 'retroarch-emscripten-esm',
        filesystem: 'memfs',
        threaded: false,
        saveCompletion: 'none',
        contentExtensions: ['j64', 'jag', 'rom', 'abs', 'cof', 'bin', 'prg'],
        maxContentBytes: 67108864,
        buildVersion: 'RetroArch 4d4bfc0f / Virtual Jaguar ffea7893 BIOS-free / emcc 3.1.46',
        loader: artifact('virtualjaguar_libretro.js', 'loader.js'),
        wasm: artifact('virtualjaguar_libretro.wasm', 'core.wasm'),
        assets: [],
      },
    },
  };
  writeFileSync(join(output, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(build, 'ECS-BUILD.json'),
    `${JSON.stringify({ frontendPin, corePin: virtualJaguarPin, sdk: '3.1.46', sdkCommit: '19607820c447a13fd8d0b7680c56148427d6e1b8', frontendFlags: flags, coreFlags: ['platform=emscripten'], limits: 'Cartridge/ABS HLE only; no encrypted/GPU-only boot, CD, BIOS, synchronized saves, or archive extraction.', licenses: ['RetroArch GPL-3.0-or-later', 'Virtual Jaguar GPL-3.0; retain all dependency notices'], sanitizerSha256: digest(readFileSync(new URL('./virtualjaguar-bios-free.mjs', import.meta.url))) }, null, 2)}\n`,
  );
  mkdirSync(join(build, 'ecs-recipes'));
  for (const file of [
    'build-virtualjaguar.mjs',
    'virtualjaguar-bios-free.mjs',
    'source.mjs',
    'generate-smoke-program.mjs',
  ])
    copyFileSync(fileURLToPath(new URL(file, import.meta.url)), join(build, 'ecs-recipes', file));
  run(
    'tar',
    [
      '--exclude=.git',
      '--exclude=*.o',
      '--exclude=*.bc',
      '--exclude=*.a',
      '--exclude=._*',
      '--exclude=*.wasm',
      '--exclude=virtualjaguar_libretro.js',
      '--exclude=*.d',
      '--exclude=.build-config*',
      '-czf',
      `${output}.source.tar.gz`,
      '-C',
      build,
      'frontend',
      'virtualjaguar',
      'ecs-recipes',
      'ECS-BUILD.json',
    ],
    build,
  );
  console.log(JSON.stringify({ output, source: `${output}.source.tar.gz`, manifest }, null, 2));
} finally {
  rmSync(build, { recursive: true, force: true });
}
