/** Shared pinned recipe for small, software-rendered libretro cores. */
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotSource } from './source.mjs';

const config = JSON.parse(readFileSync(new URL('./buildbot-config.json', import.meta.url)));
const repository = fileURLToPath(new URL('../..', import.meta.url));
export function softwareCorePlan(id) {
  const core = config.cores.find((core) => core.id === id && core.software);
  if (!core) throw Error('Unknown software recipe');
  const targetName = core.software.targetName ?? id;
  const makeDirectory = core.software.makeDirectory ?? '.';
  if (
    !/^[a-z0-9_]+$/.test(targetName) ||
    !/^(\.|[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/.test(makeDirectory)
  )
    throw Error('Unsafe software build target');
  return {
    core,
    targetName,
    makeDirectory,
    frontendPin: config.frontend.revision,
    coreFlags: [
      'platform=emscripten',
      'CC=emcc',
      'CXX=em++',
      'AR=emar',
      `GIT_VERSION=" ${core.revision.slice(0, 7)}"`,
    ],
    frontendFlags: [
      `LIBRETRO=${targetName}`,
      'HAVE_THREADS=0',
      'PROXY_TO_PTHREAD=0',
      'HAVE_WASMFS=0',
      'HAVE_EXTRA_WASMFS=0',
      'HAVE_AUDIOWORKLET=0',
      'JSPI=0',
      'FS_DEBUG=0',
      'HAVE_7ZIP=0',
      `GIT_VERSION=${config.frontend.revision.slice(0, 7)}`,
    ],
  };
}
export function softwareCoreManifest(id, loader, wasm) {
  const { core, frontendPin } = softwareCorePlan(id);
  const artifact = (file, bytes) => ({
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  return {
    id: `org.libretro.${id}`,
    name: core.software.name,
    kind: 'player',
    version: '1.0.0',
    engine: 'ecs.plugin/1',
    apps: ['org.provenance-emu.provenance'],
    player: {
      systems: core.software.systems,
      module: 'core.wasm',
      web: {
        profileVersion: 1,
        runtime: 'retroarch-emscripten-esm',
        filesystem: 'memfs',
        threaded: false,
        saveCompletion: 'none',
        contentExtensions: core.software.extensions,
        maxContentBytes: core.software.maxContentBytes,
        buildVersion: `RetroArch ${frontendPin.slice(0, 8)} / ${id} ${core.revision.slice(0, 8)} / emcc ${config.emsdk.version}`,
        loader: artifact('loader.js', loader),
        wasm: artifact('core.wasm', wasm),
        assets: [],
      },
    },
  };
}
function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: capture ? 'pipe' : 'inherit',
    env: { ...process.env, BINARYEN_CORES: '2', EMCC_CORES: '2' },
  });
  if (result.error || result.status !== 0)
    throw Error(`${command} failed (${result.status ?? result.error?.message})`);
  return result.stdout ?? '';
}
function compiler(root) {
  if (
    !run('emcc', ['--version'], root, true).includes(
      ` ${config.emsdk.version} (${config.emsdk.compilerRevision})`,
    )
  )
    throw Error('Pinned Emscripten compiler required');
}
function compile(plan, frontend, core) {
  const makeRoot = join(core, plan.makeDirectory);
  run('emmake', ['make', '-j2', ...plan.coreFlags], makeRoot);
  copyFileSync(
    join(makeRoot, `${plan.targetName}_libretro_emscripten.bc`),
    join(frontend, 'libretro_emscripten.bc'),
  );
  run('emmake', ['make', '-j2', '-f', 'Makefile.emscripten', ...plan.frontendFlags], frontend);
  return [
    readFileSync(join(frontend, `${plan.targetName}_libretro.js`)),
    readFileSync(join(frontend, `${plan.targetName}_libretro.wasm`)),
  ];
}
function writePlayer(output, manifest, loader, wasm) {
  mkdirSync(output);
  for (const [file, bytes] of [
    ['loader.js', loader],
    ['core.wasm', wasm],
    ['plugin.json', `${JSON.stringify(manifest, null, 2)}\n`],
  ])
    writeFileSync(join(output, file), bytes, { flag: 'wx' });
}
export function buildSoftwareCore(frontendInput, coreInput, output, id) {
  const plan = softwareCorePlan(id);
  for (const path of [frontendInput, coreInput, output]) {
    const actual = existsSync(path)
      ? realpathSync(path)
      : join(realpathSync(dirname(path)), path.split(/[\\/]/).at(-1));
    const within = relative(repository, actual);
    if (!isAbsolute(within) && within !== '..' && !within.startsWith('../'))
      throw Error('Build outside repository');
  }
  if (existsSync(output) || existsSync(`${output}.build.json`)) throw Error('Output must be new');
  compiler(frontendInput);
  const build = mkdtempSync(join(tmpdir(), `ecs-${id}-`));
  try {
    const frontend = join(build, 'frontend'),
      core = join(build, id);
    snapshotSource(frontendInput, frontend, plan.frontendPin);
    snapshotSource(coreInput, core, plan.core.revision);
    const [loader, wasm] = compile(plan, frontend, core),
      manifest = softwareCoreManifest(id, loader, wasm);
    writePlayer(output, manifest, loader, wasm);
    writeFileSync(
      `${output}.build.json`,
      `${JSON.stringify({ id, frontendPin: plan.frontendPin, corePin: plan.core.revision, sdk: config.emsdk.version, compilerRevision: config.emsdk.compilerRevision, coreFlags: plan.coreFlags, frontendFlags: plan.frontendFlags, manifest }, null, 2)}\n`,
      { flag: 'wx' },
    );
    return manifest;
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}
export function rebuildSoftwareCore(root, output) {
  if (existsSync(output)) throw Error('Output must be new');
  const receipt = JSON.parse(readFileSync(join(root, 'ECS-BUILD.json'))),
    plan = softwareCorePlan(receipt.id);
  if (receipt.frontendPin !== plan.frontendPin || receipt.corePin !== plan.core.revision)
    throw Error('Wrong source release');
  compiler(root);
  const [loader, wasm] = compile(
    plan,
    join(root, 'frontend'),
    join(root, plan.core.sourceDirectory),
  );
  const manifest = softwareCoreManifest(receipt.id, loader, wasm);
  for (const key of ['loader', 'wasm'])
    if (manifest.player.web[key].sha256 !== receipt.manifest.player.web[key].sha256)
      throw Error(`Rebuilt artifact differs: ${key}`);
  writePlayer(output, manifest, loader, wasm);
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 6)
    throw Error('Usage: build-software-core.mjs FRONTEND CORE NEW_PLAYER CORE_ID');
  const [frontend, core, output, id] = process.argv.slice(2);
  console.log(
    JSON.stringify(
      buildSoftwareCore(resolve(frontend), resolve(core), resolve(output), id),
      null,
      2,
    ),
  );
}
