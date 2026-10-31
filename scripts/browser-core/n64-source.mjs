/** Operator-local N64 source build. GLideN64's GPL upgrade grant remains unresolved. */
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
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotSource } from './source.mjs';

export const n64Pins = Object.freeze({
  core: '15bada85906593376e8fd697f1b0b3af3a20f512',
  frontend: '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66',
  sdk: '3.1.46',
  compiler: '19607820c447a13fd8d0b7680c56148427d6e1b8',
});
const directory = fileURLToPath(new URL('.', import.meta.url));
const repository = fileURLToPath(new URL('../..', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const n64CoreFlags = [
  'platform=emscripten',
  'CC=emcc',
  'CXX=em++',
  'AR=emar',
  'STATIC_LINKING=1',
  'GLES3=1',
  'FORCE_GLES3=1',
  'HAVE_PARALLEL_RSP=0',
  'HAVE_PARALLEL_RDP=0',
  'HAVE_THR_AL=0',
  'LLE=0',
  'GIT_VERSION=" 15bada8"',
];
export const n64FrontendFlags = [
  'ECS_N64_LINK_OPT=0',
  'ASSERTIONS=0',
  'LIBRETRO=mupen64plus_next',
  'HAVE_OPENGLES3=1',
  'HAVE_THREADS=0',
  'PROXY_TO_PTHREAD=0',
  'ASYNC=1',
  'MIN_ASYNC=0',
  'JSPI=0',
  'HAVE_WASMFS=0',
  'HAVE_EXTRA_WASMFS=0',
  'HAVE_AUDIOWORKLET=0',
  'HAVE_7ZIP=0',
  'HAVE_NETWORKING=0',
  'HAVE_REWIND=0',
  'HAVE_RUNAHEAD=0',
  'GIT_VERSION=4d4bfc0',
];
export function patchN64Frontend(frontend) {
  const path = join(frontend, 'Makefile.emscripten'),
    source = readFileSync(path, 'utf8');
  if (source.split('   LDFLAGS += -O3').length !== 2)
    throw Error('N64 frontend optimization patch input mismatch');
  const assertionFlags =
    'ifneq ($(ASSERTIONS), 0)\n   LDFLAGS += -s ASSERTIONS=$(ASSERTIONS)\nendif';
  if (source.split(assertionFlags).length !== 2)
    throw Error('N64 frontend assertion patch input mismatch');
  writeFileSync(
    path,
    source
      .replace('   LDFLAGS += -O3', '   LDFLAGS += -O$(ECS_N64_LINK_OPT)')
      .replace(assertionFlags, 'LDFLAGS += -s ASSERTIONS=$(ASSERTIONS)'),
  );
}
export function minifyN64Loader(input, sdkRoot) {
  const loader = Buffer.from(
    run(
      process.execPath,
      [join(sdkRoot, 'tools/acorn-optimizer.js'), input, 'minifyWhitespace', '--exportES6'],
      dirname(input),
      true,
    ),
  );
  if (
    /\bimport\b\s*(?!\s*\.)|\b(?:Worker|SharedWorker)\s*\(|\b(?:audioWorklet|paintWorklet)\b|\bimportScripts\s*\(/.test(
      loader.toString('utf8'),
    )
  )
    throw Error('Unsupported loader capability after pinned SDK minimization');
  return loader;
}
function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: capture ? 'pipe' : 'inherit',
    env: { ...process.env, EMCC_CORES: '2', BINARYEN_CORES: '2' },
  });
  if (result.error || result.status !== 0)
    throw Error(
      `${command} failed (${result.status ?? result.error?.message}): ${result.stderr ?? ''}`,
    );
  return result.stdout ?? '';
}
function compiler(root) {
  if (!run('emcc', ['--version'], root, true).includes(` ${n64Pins.sdk} (${n64Pins.compiler})`))
    throw Error('Pinned Emscripten 3.1.46 compiler required');
}
function outsideRepository(path) {
  const actual = existsSync(path)
    ? realpathSync(path)
    : join(realpathSync(dirname(path)), path.split('/').at(-1));
  const within = relative(repository, actual);
  if (!isAbsolute(within) && within !== '..' && !within.startsWith('../'))
    throw Error('N64 source and player artifacts must remain outside the repository');
}
export function patchN64Source(core) {
  function replace(file, original, replacement) {
    const path = join(core, file),
      source = readFileSync(path, 'utf8');
    if (source.split(original).length !== 2) throw Error(`N64 patch input mismatch: ${file}`);
    writeFileSync(path, source.replace(original, replacement));
  }
  replace(
    'Makefile',
    '# Use -fcommon\nCPUOPTS += -fcommon',
    'ifeq ($(platform), emscripten)\nCPUOPTS += -fno-common\nelse\nCPUOPTS += -fcommon\nendif',
  );
  replace(
    'libretro-common/libco/libco.c',
    '#if defined _MSC_VER',
    '#if defined(__EMSCRIPTEN__)\n  #include "emscripten.c"\n#elif defined _MSC_VER',
  );
  copyFileSync(join(directory, 'n64-fiber.c'), join(core, 'libretro-common/libco/emscripten.c'));
  replace(
    'libretro/libretro.c',
    'static void reinit_gfx_plugin(void)',
    'static void EmuCoThreadFunction(void)\n{\n    (void)EmuThreadFunction(NULL);\n}\n\nstatic void reinit_gfx_plugin(void)',
  );
  replace('libretro/libretro.c', '(void (*)(void))EmuThreadFunction', 'EmuCoThreadFunction');
  replace(
    'Makefile',
    '   CPUFLAGS += -DEMSCRIPTEN -DNO_ASM -s USE_ZLIB=1',
    '   CPUFLAGS += -DEMSCRIPTEN -DNO_ASM -s USE_ZLIB=1\n   PLATCFLAGS += -Dconvert_float_to_s16=glupen_convert_float_to_s16 -Dconvert_s16_to_float=glupen_convert_s16_to_float',
  );
  for (const file of ['include/glsym/glsym_es3.h', 'glsym/glsym_es3.c']) {
    const path = join(core, 'libretro-common', file),
      source = readFileSync(path, 'utf8');
    if (!source.includes('__rglgen_')) throw Error(`Missing GLES symbol namespace: ${file}`);
    writeFileSync(path, source.replaceAll('__rglgen_', '__glupen_rglgen_'));
  }
  replace(
    'GLideN64/src/Graphics/OpenGLContext/opengl_GLInfo.cpp',
    '\tisGLESX = strstr(strDriverVersion, "OpenGL ES") != nullptr;',
    '#if defined(__EMSCRIPTEN__) && defined(HAVE_OPENGLES3)\n\tisGLESX = true;\n\tisGLES2 = false;\n\tmajorVersion = 3;\n\tminorVersion = 0;\n#else\n\tisGLESX = strstr(strDriverVersion, "OpenGL ES") != nullptr;',
  );
  replace(
    'GLideN64/src/Graphics/OpenGLContext/opengl_GLInfo.cpp',
    '\n#if defined(HAVE_OPENGLES2) // Overwrite',
    '\n#endif\n\n#if defined(HAVE_OPENGLES2) // Overwrite',
  );
  replace(
    'libretro/libretro.c',
    '    CoreShutdown();\n    deinit_audio_libretro();',
    '    CoreShutdown();\n#ifdef __EMSCRIPTEN__\n    co_delete(game_thread);\n    game_thread = NULL;\n#endif\n    deinit_audio_libretro();',
  );
  replace(
    'libretro/libretro.c',
    '          EnableThreadedRenderer = !strcmp(var.value, "True") ? 1 : 0;',
    '#ifndef __EMSCRIPTEN__\n          EnableThreadedRenderer = !strcmp(var.value, "True") ? 1 : 0;\n#endif',
  );
  replace(
    'custom/mupen64plus-next_common.h',
    'extern uint32_t EnableThreadedRenderer;',
    '#ifdef __EMSCRIPTEN__\n#define EnableThreadedRenderer 0\n#else\nextern uint32_t EnableThreadedRenderer;\n#endif',
  );
  replace(
    'libretro/libretro.c',
    'uint32_t EnableThreadedRenderer = 0;',
    '#ifndef __EMSCRIPTEN__\nuint32_t EnableThreadedRenderer = 0;\n#endif',
  );
  replace(
    'libretro/libretro.c',
    '    char* newPath;\n\n    // Workaround',
    '    char* newPath;\n\n#ifdef __EMSCRIPTEN__\n    if (!game_thread)\n        return false;\n#endif\n\n    // Workaround',
  );
}
function compile(root) {
  const core = join(root, 'mupen64plus-next'),
    frontend = join(root, 'frontend');
  run('emmake', ['make', '-j2', ...n64CoreFlags], core);
  copyFileSync(
    join(core, 'mupen64plus_next_libretro_emscripten.bc'),
    join(frontend, 'libretro_emscripten.bc'),
  );
  run('emmake', ['make', '-j2', '-f', 'Makefile.emscripten', ...n64FrontendFlags], frontend);
  const rawLoader = join(frontend, 'mupen64plus_next_libretro.js');
  const sdkRoot = run('em-config', ['EMSCRIPTEN_ROOT'], root, true).trim();
  return [
    minifyN64Loader(rawLoader, sdkRoot),
    readFileSync(join(frontend, 'mupen64plus_next_libretro.wasm')),
    {
      tool: 'tools/acorn-optimizer.js',
      sha256: hash(readFileSync(join(sdkRoot, 'tools/acorn-optimizer.js'))),
      passes: ['minifyWhitespace', '--exportES6'],
      nodeVersion: process.version,
      rawLoaderSha256: hash(readFileSync(rawLoader)),
    },
  ];
}
function manifest(loader, wasm) {
  return {
    id: 'org.libretro.mupen64plus-next',
    name: 'Mupen64Plus-Next (operator-local fiber port)',
    kind: 'player',
    version: '0.1.0',
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
        maxContentBytes: 134217728,
        defaultCoreOptions: {
          'mupen64plus-cpucore': 'cached_interpreter',
          'mupen64plus-rdp-plugin': 'gliden64',
          'mupen64plus-rsp-plugin': 'hle',
          'mupen64plus-ThreadedRenderer': 'False',
          'mupen64plus-43screensize': '320x240',
        },
        buildVersion: `RetroArch 4d4bfc0f / Mupen64Plus-Next 15bada85 / emcc ${n64Pins.sdk} / fibers`,
        loader: { file: 'loader.js', sha256: hash(loader) },
        wasm: { file: 'core.wasm', sha256: hash(wasm) },
        assets: [],
      },
    },
  };
}
function writePlayer(output, loader, wasm, profile) {
  mkdirSync(output);
  writeFileSync(join(output, 'loader.js'), loader, { flag: 'wx' });
  writeFileSync(join(output, 'core.wasm'), wasm, { flag: 'wx' });
  writeFileSync(join(output, 'plugin.json'), `${JSON.stringify(profile, null, 2)}\n`, {
    flag: 'wx',
  });
}
export function buildN64Source(frontendInput, coreInput, root, output) {
  for (const path of [frontendInput, coreInput, root, output]) outsideRepository(path);
  if (existsSync(root) || existsSync(output))
    throw Error('Source stage and player output must be new');
  compiler(frontendInput);
  mkdirSync(root);
  snapshotSource(frontendInput, join(root, 'frontend'), n64Pins.frontend);
  snapshotSource(coreInput, join(root, 'mupen64plus-next'), n64Pins.core);
  patchN64Source(join(root, 'mupen64plus-next'));
  patchN64Frontend(join(root, 'frontend'));
  const receipt = {
    pins: n64Pins,
    coreFlags: n64CoreFlags,
    frontendFlags: n64FrontendFlags,
    fiberSha256: hash(readFileSync(join(directory, 'n64-fiber.c'))),
    recipeSha256: hash(readFileSync(join(directory, 'n64-source.mjs'))),
    publication: 'operator-local only: GLideN64 GPL-2.0 upgrade permission unresolved',
  };
  writeFileSync(join(root, 'ECS-BUILD.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });
  return completeN64SourceBuild(root, output);
}
export function completeN64SourceBuild(root, output) {
  outsideRepository(root);
  outsideRepository(output);
  compiler(root);
  if (existsSync(output)) throw Error('Player output must be new');
  const receipt = JSON.parse(readFileSync(join(root, 'ECS-BUILD.json')));
  if (JSON.stringify(receipt.pins) !== JSON.stringify(n64Pins))
    throw Error('Wrong N64 source pins');
  const [loader, wasm, loaderMinifier] = compile(root),
    profile = manifest(loader, wasm);
  if (
    receipt.manifest &&
    (profile.player.web.loader.sha256 !== receipt.manifest.player.web.loader.sha256 ||
      profile.player.web.wasm.sha256 !== receipt.manifest.player.web.wasm.sha256)
  )
    throw Error('Rebuilt N64 artifacts differ from the operator-local receipt');
  writePlayer(output, loader, wasm, profile);
  writeFileSync(
    join(root, 'ECS-BUILD.json'),
    `${JSON.stringify(
      {
        ...receipt,
        coreFlags: n64CoreFlags,
        frontendFlags: n64FrontendFlags,
        loaderMinifier,
        fiberSha256: hash(
          readFileSync(join(root, 'mupen64plus-next/libretro-common/libco/emscripten.c')),
        ),
        recipeSha256: hash(readFileSync(join(directory, 'n64-source.mjs'))),
        sourceDiffSha256: hash(
          run(
            'git',
            ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'],
            join(root, 'mupen64plus-next'),
            true,
          ),
        ),
        frontendDiffSha256: hash(
          run(
            'git',
            ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'],
            join(root, 'frontend'),
            true,
          ),
        ),
        sources: {
          core: 'https://github.com/libretro/mupen64plus-libretro-nx',
          frontend: 'https://github.com/libretro/RetroArch',
          sdk: 'https://github.com/emscripten-core/emsdk',
        },
        manifest: profile,
      },
      null,
      2,
    )}\n`,
  );
  return profile;
}
export function rebuildN64Source(root, output) {
  const receipt = JSON.parse(readFileSync(join(root, 'ECS-BUILD.json')));
  if (!receipt.manifest)
    throw Error('The source stage has no completed operator-local build receipt');
  return completeN64SourceBuild(root, output);
}
