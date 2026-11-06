/** Rebuild original FCEUmm corresponding source; verify both produced hashes before emitting a player. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_PIN = '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66';
const CORE_PIN = 'ac0d00a7fc01166f84c7bac01d1084ebfd2b865e';

export function fceummSourcePlan(root, legacyManifest) {
  if (existsSync(join(root, 'ECS-BUILD.json'))) {
    const receipt = JSON.parse(readFileSync(join(root, 'ECS-BUILD.json'), 'utf8'));
    if (receipt.frontendPin !== FRONTEND_PIN || receipt.corePin !== CORE_PIN)
      throw new Error('Wrong source release');
    return { frontend: join(root, 'frontend'), patch: null, receipt, sourceDateEpoch: null };
  }
  if (!legacyManifest)
    throw new Error('The published legacy archive requires --package PINNED_FCEUMM_PACKAGE');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  if (![FRONTEND_PIN, CORE_PIN, '3.1.46'].every((pin) => readme.includes(pin)))
    throw new Error('Wrong source release');
  return {
    sourceDateEpoch: '1793145600',
    frontend: join(root, 'retroarch'),
    patch: join(root, 'retroarch-save-files.patch'),
    receipt: {
      frontendPin: FRONTEND_PIN,
      corePin: CORE_PIN,
      manifest: legacyManifest,
      frontendFlags: [
        'LIBRETRO=fceumm',
        'HAVE_THREADS=0',
        'PROXY_TO_PTHREAD=0',
        'HAVE_WASMFS=0',
        'HAVE_EXTRA_WASMFS=0',
        'HAVE_AUDIOWORKLET=0',
        'JSPI=0',
        'FS_DEBUG=0',
      ],
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (
    ![4, 6].includes(process.argv.length) ||
    (process.argv.length === 6 && process.argv[4] !== '--package')
  )
    throw new Error(
      'Usage: rebuild-fceumm-source.mjs EXTRACTED_SOURCE_ROOT NEW_OUTPUT [--package PINNED_FCEUMM_PACKAGE]',
    );
  const [root, output] = process.argv.slice(2, 4).map((path) => resolve(path));
  if (existsSync(output)) throw new Error('Output must be new');
  let legacyManifest;
  if (process.argv[5]) {
    const info = statSync(process.argv[5]);
    if (!info.isFile() || info.size !== 4480582) throw new Error('Wrong published FCEUmm package');
    const bytes = readFileSync(process.argv[5]);
    if (
      createHash('sha256').update(bytes).digest('hex') !==
      '7baae6ca0e8addebd01d2cb91d29a69c29534c7b1ac65804b3e044af32052700'
    )
      throw new Error('Wrong published FCEUmm package');
    const length = bytes.readUInt32BE(0);
    legacyManifest = JSON.parse(bytes.subarray(4, length + 4).toString('utf8')).manifest;
  }
  const { frontend, patch, receipt, sourceDateEpoch } = fceummSourcePlan(root, legacyManifest);
  function run(command, args, cwd, capture = false) {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: capture ? 'pipe' : 'inherit',
      env: {
        ...process.env,
        BINARYEN_CORES: '2',
        EMCC_CORES: '2',
        ...(sourceDateEpoch ? { SOURCE_DATE_EPOCH: sourceDateEpoch } : {}),
      },
    });
    if (result.error || result.status !== 0) throw new Error(`${command} failed`);
    return result.stdout ?? '';
  }
  if (!/^emcc .* 3\.1\.46\b/m.test(run('emcc', ['--version'], root, true)))
    throw new Error('Activate SDK 3.1.46');
  const core = join(root, 'fceumm');
  if (patch) {
    if (
      createHash('sha256').update(readFileSync(patch)).digest('hex') !==
      'ffc78048f23214a2aaccd84e7c8e443edfce06a194aa501818dcb11923738f21'
    )
      throw new Error('Source patch digest mismatch');
    const check = spawnSync('git', ['apply', '--check', patch], { cwd: frontend, stdio: 'ignore' });
    if (check.status === 0) run('git', ['apply', patch], frontend);
    else run('git', ['apply', '--reverse', '--check', patch], frontend);
  }
  run(
    'emmake',
    ['make', '-j2', '-f', 'Makefile.libretro', 'platform=emscripten', 'GIT_VERSION=" ac0d00a"'],
    core,
  );
  copyFileSync(
    join(core, 'fceumm_libretro_emscripten.bc'),
    join(frontend, 'libretro_emscripten.bc'),
  );
  for (const file of ['retroarch.o', 'version_git.o', 'menu/menu_displaylist.o'])
    rmSync(join(frontend, 'obj-emscripten', file), { force: true });
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
}
