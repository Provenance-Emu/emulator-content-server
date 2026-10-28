/** Rebuild an extracted corresponding-source archive without Git metadata or firmware. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (process.argv.length !== 4)
  throw new Error('Usage: node rebuild-pcsx-source.mjs EXTRACTED_SOURCE_ROOT NEW_OUTPUT');
const [root, output] = process.argv.slice(2).map((path) => resolve(path));
if (existsSync(output)) throw new Error('Output must be new');
const receipt = JSON.parse(readFileSync(join(root, 'ECS-BUILD.json'), 'utf8'));
if (
  receipt.frontendPin !== '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66' ||
  receipt.corePin !== 'c8816799b50388e61cfe237fe2cdbb7d8175f20a'
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
const core = join(root, 'pcsx-rearmed'),
  frontend = join(root, 'frontend');
run(
  'emmake',
  [
    'make',
    '-j2',
    '-f',
    'Makefile.libretro',
    'platform=emscripten',
    'CC=emcc',
    'CXX=em++',
    'AR=emar',
    'NDRC_THREAD=0',
    'GIT_VERSION=" c881679"',
  ],
  core,
);
copyFileSync(
  join(core, 'pcsx_rearmed_libretro_emscripten.bc'),
  join(frontend, 'libretro_emscripten.bc'),
);
run(
  'emmake',
  ['make', '-j2', '-f', 'Makefile.emscripten', ...receipt.frontendFlags, 'GIT_VERSION=4d4bfc0'],
  frontend,
);
const manifest = receipt.manifest,
  artifacts = [];
for (const [source, file, expected] of [
  ['pcsx_rearmed_libretro.js', 'loader.js', manifest.player.web.loader],
  ['pcsx_rearmed_libretro.wasm', 'core.wasm', manifest.player.web.wasm],
]) {
  const bytes = readFileSync(join(frontend, source)),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected.sha256)
    throw new Error(`Rebuilt artifact differs from release: ${file} (${sha256})`);
  artifacts.push({ file, bytes, sha256 });
}
mkdirSync(output);
for (const artifact of artifacts)
  writeFileSync(join(output, artifact.file), artifact.bytes, { flag: 'wx' });
writeFileSync(join(output, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      output,
      artifacts: artifacts.map(({ file, bytes, sha256 }) => ({
        file,
        sizeBytes: bytes.length,
        sha256,
      })),
    },
    null,
    2,
  ),
);
