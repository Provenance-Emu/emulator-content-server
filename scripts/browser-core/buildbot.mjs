#!/usr/bin/env node
/** Manual source builds in this central repository. Produces artifacts, never publishes a release. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { smokeLibretroPairs } from './libretro-runtime-audit.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
export const buildbotConfig = JSON.parse(
  await readFile(new URL('./buildbot-config.json', import.meta.url), 'utf8'),
);
export function buildPlan(id) {
  const core = buildbotConfig.cores.find((core) => core.id === id);
  if (!core) throw new Error('Unknown buildbot core');
  for (const source of [core, buildbotConfig.frontend, buildbotConfig.emsdk]) {
    if (
      !/^[a-f0-9]{40}$/.test(source.revision) ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository)
    )
      throw new Error('Immutable official source pin required');
  }
  return {
    core,
    frontend: buildbotConfig.frontend,
    emsdk: buildbotConfig.emsdk,
    parallelism: 2,
    publication: 'none',
    acceptance: ['stella2014', 'atari800'].includes(core.id)
      ? `production-opaque-original-${core.id === 'stella2014' ? 'a26' : 'bin'}-video`
      : 'production-opaque-factory-memfs-only',
  };
}
function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, BINARYEN_CORES: '2', EMCC_CORES: '2' },
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed (${result.status ?? result.error?.message})`);
  return result.stdout?.trim();
}
async function checkout(source, path) {
  await mkdir(path);
  run('git', ['init', '--quiet'], path);
  run('git', ['remote', 'add', 'origin', source.repository], path);
  run('git', ['fetch', '--depth=1', 'origin', source.revision], path);
  run('git', ['checkout', '--detach', '--quiet', source.revision], path);
  if (run('git', ['rev-parse', 'HEAD'], path, true) !== source.revision)
    throw new Error('Source checkout pin mismatch');
}
export async function runBuildbot(id, destination, { verifyRebuild = false } = {}) {
  const plan = buildPlan(id),
    output = resolve(destination);
  const actual = join(await realpath(dirname(output)), output.split(/[\\/]/).at(-1));
  const within = relative(repository, actual);
  if (!isAbsolute(within) && within !== '..' && !within.startsWith('../'))
    throw new Error('Buildbot output must be outside repository');
  const compilerVersion = run('emcc', ['--version'], repository, true);
  if (!compilerVersion.includes(` ${plan.emsdk.version} (${plan.emsdk.compilerRevision})`))
    throw new Error('Pinned Emscripten compiler revision required');
  await mkdir(output); // Exclusive new workspace; operator paths are never reused or cleaned.
  const frontend = join(output, 'frontend-input'),
    core = join(output, 'core-input'),
    player = join(output, 'players', id),
    artifacts = join(output, 'artifacts');
  await mkdir(dirname(player));
  await mkdir(artifacts);
  await checkout(plan.frontend, frontend);
  await checkout(plan.core, core);
  run(
    process.execPath,
    [
      join(repository, 'scripts/browser-core', plan.core.recipe),
      frontend,
      core,
      plan.core.rawOutput ? join(output, 'raw-core') : player,
      ...(plan.core.recipeArguments ?? []),
    ],
    repository,
  );
  if (plan.core.rawOutput) {
    const { installPinnedPlayer } = await import('./install-plugin.mjs');
    await installPinnedPlayer(join(output, 'raw-core'), player);
  }
  const { packagePlayer } = await import('./package-player.mjs');
  const packageBytes = await packagePlayer(player, join(artifacts, `${id}.ecsplayer`));
  const manifest = JSON.parse(await readFile(join(player, 'plugin.json'), 'utf8')),
    web = manifest.player.web;
  let originalContentPath, contentExtension;
  if (id === 'stella2014') {
    const { atari2600SmokeCartridge } = await import('./generate-2600-smoke.mjs');
    contentExtension = 'a26';
    originalContentPath = join(output, 'original.a26');
    await writeFile(originalContentPath, atari2600SmokeCartridge(), { flag: 'wx' });
  }
  if (id === 'atari800') {
    const { atari5200SmokeCartridge } = await import('./generate-5200-smoke.mjs');
    contentExtension = 'bin';
    originalContentPath = join(output, 'original.a52');
    await writeFile(originalContentPath, atari5200SmokeCartridge(), { flag: 'wx' });
  }
  const smoke = await smokeLibretroPairs(
    [
      {
        core: id.replaceAll('-', '_'),
        loaderPath: join(player, web.loader.file),
        wasmPath: join(player, web.wasm.file),
        coreOptions: web.defaultCoreOptions ?? {},
        ...(originalContentPath ? { originalContentPath, contentExtension } : {}),
      },
    ],
    artifacts,
  );
  if (
    smoke.results.length !== 1 ||
    smoke.results.some(
      (result) => !result.ok || result.pageErrors.length || result.unexpectedRequests.length,
    )
  )
    throw new Error('Production opaque-sandbox startup acceptance failed');
  const sourceArchive = join(artifacts, `${id}.source.tar.gz`);
  if (plan.core.sanitizedSourceArchive) await copyFile(`${player}.source.tar.gz`, sourceArchive);
  else {
    const source = join(output, 'corresponding-source');
    await mkdir(source);
    for (const [checkoutPath, name] of [
      [frontend, 'frontend'],
      [core, plan.core.sourceDirectory],
    ]) {
      const tar = join(output, `${name}.tar`);
      run('git', ['archive', '--format=tar', `--prefix=${name}/`, '-o', tar, 'HEAD'], checkoutPath);
      run('tar', ['-xf', tar, '-C', source], output);
    }
    for (const patch of plan.core.patches ?? []) {
      if (!/^[a-z0-9-]+\.patch$/.test(patch)) throw Error('Invalid source patch name');
      run(
        'git',
        ['apply', '--ignore-whitespace', join(repository, 'scripts/browser-core', patch)],
        join(source, plan.core.sourceDirectory),
      );
    }
    if (plan.core.rawOutput) {
      run(
        'git',
        ['apply', join(repository, 'scripts/browser-core/retroarch-save-files.patch')],
        join(source, 'frontend'),
      );
      await writeFile(
        join(source, 'ECS-BUILD.json'),
        JSON.stringify(
          {
            frontendPin: plan.frontend.revision,
            corePin: plan.core.revision,
            sdk: plan.emsdk.version,
            compilerRevision: plan.emsdk.compilerRevision,
            emsdkRevision: plan.emsdk.revision,
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
            manifest,
          },
          null,
          2,
        ),
      );
    } else await copyFile(`${player}.build.json`, join(source, 'ECS-BUILD.json'));
    await mkdir(join(source, 'ecs-recipes'));
    for (const file of [
      plan.core.recipe,
      plan.core.rebuild,
      'source.mjs',
      'buildbot-config.json',
      ...(plan.core.patches ?? []),
    ])
      await copyFile(
        join(repository, 'scripts/browser-core', file),
        join(source, 'ecs-recipes', file),
      );
    if (plan.core.rawOutput)
      await copyFile(
        join(repository, 'scripts/browser-core/retroarch-save-files.patch'),
        join(source, 'ecs-recipes/retroarch-save-files.patch'),
      );
    await writeFile(
      join(source, 'REBUILD.md'),
      `Activate Emscripten ${plan.emsdk.version} (compiler ${plan.emsdk.compilerRevision}, emsdk ${plan.emsdk.revision}); run node ecs-recipes/${plan.core.rebuild} EXTRACTED_SOURCE_ROOT NEW_EXTERNAL_OUTPUT. Original source and dependency notices are retained.\n`,
    );
    run('tar', ['-czf', sourceArchive, '-C', source, '.'], output);
  }
  if (verifyRebuild) {
    const extracted = join(output, 'source-rebuild'),
      rebuilt = join(output, 'rebuilt-player');
    await mkdir(extracted);
    run('tar', ['-xzf', sourceArchive, '-C', extracted], output);
    run(
      process.execPath,
      [join(extracted, 'ecs-recipes', plan.core.rebuild), extracted, rebuilt],
      output,
    );
    for (const spec of [web.loader, web.wasm]) {
      const bytes = await readFile(join(rebuilt, spec.file));
      if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256)
        throw new Error('Corresponding-source rebuild differs from built package');
    }
  }
  const notices = `Manual source-build artifact. The build driver does not publish; an explicitly requested separate workflow job may publish a prerelease.\n${plan.core.licenses.join('\n')}\n\nComplete corresponding frontend/core source, dependency notices and rebuild recipes accompany the binary. No user content, saves, NAND or BIOS files are inputs. Virtual Jaguar archives are sanitized by its existing recipe before archiving.\n\nFactory/MEMFS startup was verified in the production opaque sandbox. Commercial content, synchronized saves and game behavior are not established by this build job. Distribution still requires review of every dependency's terms.\n\n${JSON.stringify(plan, null, 2)}\n`;
  await writeFile(join(artifacts, 'NOTICES.txt'), notices);
  await copyFile(join(player, 'plugin.json'), join(artifacts, 'plugin.json'));
  const pins = [];
  for (const file of [
    `${id}.ecsplayer`,
    `${id}.source.tar.gz`,
    'NOTICES.txt',
    'plugin.json',
    'smokes.json',
  ]) {
    const bytes = await readFile(join(artifacts, file));
    pins.push({
      file,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const receipt = {
    ...plan,
    compilerVersion,
    reproducible: verifyRebuild,
    manifest,
    artifacts: pins,
    packageBytes: packageBytes.length,
    sandboxSha256: smoke.sandboxSha256,
  };
  await writeFile(join(artifacts, 'catalog.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [id, destination] = process.argv.slice(2);
  const verifyRebuild = process.argv[4] === '--verify-rebuild';
  if (
    !id ||
    !destination ||
    !(process.argv.length === 4 || (process.argv.length === 5 && verifyRebuild))
  )
    throw new Error('Usage: buildbot.mjs CORE NEW_EXTERNAL_OUTPUT (activate pinned SDK first)');
  console.log(JSON.stringify(await runBuildbot(id, destination, { verifyRebuild }), null, 2));
}
