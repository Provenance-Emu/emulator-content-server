/** Rebuild the published sanitized source tree without original BIOS arrays or Git history. */
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

if (process.argv.length !== 4)
  throw new Error(
    'Usage: node rebuild-jaguar-source.mjs EXTRACTED_SOURCE_ROOT NEW_EXTERNAL_OUTPUT',
  );
const [root, output] = process.argv.slice(2).map((path) => resolve(path));
const repository = fileURLToPath(new URL('../..', import.meta.url));
for (const path of [root, output]) {
  const actual = existsSync(path)
    ? realpathSync(path)
    : join(realpathSync(dirname(path)), path.split(/[\\/]/).at(-1));
  const within = relative(repository, actual);
  if (
    existsSync(join(repository, 'packages/protocol/openapi/openapi.yaml')) &&
    within !== '..' &&
    !within.startsWith('../') &&
    !isAbsolute(within)
  )
    throw new Error('Build outside the repository');
}
if (existsSync(output)) throw new Error('Output must be new');
const frontend = join(root, 'frontend'),
  core = join(root, 'virtualjaguar');
for (const file of ['jagbios.c', 'jagbios_m.c', 'jagcdbios.c', 'jagdevcdbios.c']) {
  const source = readFileSync(join(core, 'src/bios', file), 'utf8');
  if (
    !/^\/\* ECS (?:cartridge-only|HLE) build: boot ROM intentionally omitted\. \*\/\n#include "[A-Za-z0-9_]+\.h"\nuint8_t \w+\[0x[0-9a-f]+\] = \{0\};\n$/.test(
      source,
    )
  )
    throw new Error(`Source is not the sanitized release: ${file}`);
}
const receipt = JSON.parse(readFileSync(join(root, 'ECS-BUILD.json'), 'utf8'));
if (
  receipt.frontendPin !== '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66' ||
  receipt.corePin !== 'ffea7893a59dd9b9e6f9b85c51627810338b0778' ||
  receipt.sdk !== '3.1.46'
)
  throw new Error('Wrong source release');
function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
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
if (!/^emcc .* 3\.1\.46\b/m.test(run('emcc', ['--version'], root, true)))
  throw new Error('Activate SDK 3.1.46');
if (
  readFileSync(join(core, 'scripts/build-id.sh'), 'utf8') !==
  "#!/bin/sh\nprintf 'ffea789-dirty\\n'\n"
)
  throw new Error('Wrong core build identity');
run('emmake', ['make', '-j2', 'platform=emscripten'], core);
copyFileSync(
  join(core, 'virtualjaguar_libretro_emscripten.bc'),
  join(frontend, 'libretro_emscripten.bc'),
);
// The original measured Git abbreviation is an input to version_git.o.
const flags = [
  'LIBRETRO=virtualjaguar',
  'GIT_VERSION=4d4bfc0',
  'HAVE_THREADS=0',
  'PROXY_TO_PTHREAD=0',
  'HAVE_WASMFS=0',
  'HAVE_EXTRA_WASMFS=0',
  'HAVE_AUDIOWORKLET=0',
  'JSPI=0',
  'FS_DEBUG=0',
  'HAVE_7ZIP=0',
];
run('emmake', ['make', '-j2', '-f', 'Makefile.emscripten', ...flags], frontend);
mkdirSync(output);
const artifacts = {};
for (const [source, file] of [
  ['virtualjaguar_libretro.js', 'loader.js'],
  ['virtualjaguar_libretro.wasm', 'core.wasm'],
]) {
  const bytes = readFileSync(join(frontend, source));
  writeFileSync(join(output, file), bytes, { flag: 'wx' });
  artifacts[file] = {
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
console.log(JSON.stringify({ output, artifacts }, null, 2));
