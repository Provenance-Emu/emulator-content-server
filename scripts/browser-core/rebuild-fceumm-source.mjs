/** Rebuild original FCEUmm corresponding source; verify both produced hashes before emitting a player. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (process.argv.length !== 4)
  throw new Error('Usage: rebuild-fceumm-source.mjs EXTRACTED_SOURCE_ROOT NEW_OUTPUT');
const [root, output] = process.argv.slice(2).map((path) => resolve(path));
if (existsSync(output)) throw new Error('Output must be new');
const receipt = JSON.parse(readFileSync(join(root, 'ECS-BUILD.json'), 'utf8'));
if (
  receipt.frontendPin !== '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66' ||
  receipt.corePin !== 'ac0d00a7fc01166f84c7bac01d1084ebfd2b865e'
)
  throw new Error('Wrong source release');
function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    env: { ...process.env, BINARYEN_CORES: '2', EMCC_CORES: '2' },
  });
  if (result.error || result.status !== 0) throw new Error(`${command} failed`);
  return result.stdout ?? '';
}
if (!/^emcc .* 3\.1\.46\b/m.test(run('emcc', ['--version'], root, true)))
  throw new Error('Activate SDK 3.1.46');
const frontend = join(root, 'frontend'),
  core = join(root, 'fceumm');
run(
  'emmake',
  ['make', '-j2', '-f', 'Makefile.libretro', 'platform=emscripten', 'GIT_VERSION=" ac0d00a"'],
  core,
);
copyFileSync(join(core, 'fceumm_libretro_emscripten.bc'), join(frontend, 'libretro_emscripten.bc'));
run(
  'emmake',
  ['make', '-j2', '-f', 'Makefile.emscripten', ...receipt.frontendFlags, 'GIT_VERSION=4d4bfc0'],
  frontend,
);
const files = [];
for (const [source, spec] of [
  ['fceumm_libretro.js', receipt.manifest.player.web.loader],
  ['fceumm_libretro.wasm', receipt.manifest.player.web.wasm],
]) {
  const bytes = readFileSync(join(frontend, source));
  if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256)
    throw new Error(`Rebuilt artifact differs: ${spec.file}`);
  files.push({ file: spec.file, bytes });
}
mkdirSync(output);
for (const { file, bytes } of files) writeFileSync(join(output, file), bytes, { flag: 'wx' });
writeFileSync(join(output, 'plugin.json'), `${JSON.stringify(receipt.manifest, null, 2)}\n`);
