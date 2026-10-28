/** Convert a verified pinned FCEUmm build into a new data-only player installation. */
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlayerAssets } from '../../apps/server/dist/src/player-assets.js';

const repository = fileURLToPath(new URL('../..', import.meta.url));
export async function installPinnedPlayer(source, destination) {
  if (!isAbsolute(source) || !isAbsolute(destination))
    throw new Error('Source and new plugin directory must be absolute paths');
  const parent = await realpath(dirname(destination));
  const within = relative(repository, parent);
  if (within !== '..' && !within.startsWith('../') && !isAbsolute(within))
    throw new Error('Install emulator binaries outside this repository');
  // Validate hashes, pins, regular files and bounds before creating anything.
  const { descriptor: d, loader, wasm } = await loadPlayerAssets(source);
  const manifest = {
    id: 'org.libretro.fceumm',
    name: 'FCEUmm (NES)',
    kind: 'player',
    version: '1.0.0',
    engine: 'ecs.plugin/1',
    apps: ['org.provenance-emu.provenance'],
    player: {
      systems: d.systems,
      module: 'core.wasm',
      web: {
        profileVersion: 1,
        runtime: d.runtime,
        filesystem: d.filesystem,
        threaded: d.threaded,
        saveCompletion: d.saveCompletion,
        contentExtensions: [d.contentExtension],
        maxContentBytes: d.maxContentBytes,
        buildVersion: `RetroArch ${d.frontendCommit.slice(0, 8)} + SRAM fix / FCEUmm ${d.coreCommit.slice(0, 8)} / emcc ${d.emscriptenVersion}`,
        loader: { file: 'loader.js', sha256: d.loader.sha256 },
        wasm: { file: 'core.wasm', sha256: d.wasm.sha256 },
        assets: [],
      },
    },
  };
  await mkdir(destination); // Existing installations, even empty ones, are never overwritten.
  try {
    await writeFile(resolve(destination, 'loader.js'), loader, { flag: 'wx' });
    await writeFile(resolve(destination, 'core.wasm'), wasm, { flag: 'wx' });
    await writeFile(resolve(destination, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
    });
    return manifest;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4)
    throw new Error(
      'Usage: node scripts/browser-core/install-plugin.mjs BUILT_CORE NEW_PLUGIN_DIRECTORY',
    );
  const manifest = await installPinnedPlayer(resolve(process.argv[2]), resolve(process.argv[3]));
  console.log(`Installed ${manifest.name}: ${manifest.id}`);
}
