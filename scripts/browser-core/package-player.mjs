/** Package an already validated external plugin; no emulator bytes are tracked. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPlayerProfiles } from '../../apps/server/dist/src/player-profiles.js';
import { parsePlayerPackage } from '../../packages/plugins/dist/src/index.js';
export async function packagePlayer(directory, destination) {
  const installed = await loadPlayerProfiles(dirname(directory));
  const manifest = JSON.parse(await readFile(join(directory, 'plugin.json'), 'utf8'));
  if (!installed.items.has(manifest.id)) throw new Error('Player not validated');
  const web = manifest.player.web,
    specs = [web.loader, web.wasm, ...web.assets];
  const files = await Promise.all(
    specs.map(async (spec) => ({
      name: spec.file,
      bytes: await readFile(join(directory, spec.file)),
    })),
  );
  const header = Buffer.from(
    JSON.stringify({ manifest, files: files.map((f) => ({ name: f.name, size: f.bytes.length })) }),
  );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length);
  const bytes = Buffer.concat([prefix, header, ...files.map((f) => f.bytes)]);
  parsePlayerPackage(bytes);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: 'wx' });
  return bytes;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4)
    throw new Error(
      'Usage: node scripts/browser-core/package-player.mjs PLUGIN_DIRECTORY NEW_PACKAGE_FILE',
    );
  await packagePlayer(resolve(process.argv[2]), resolve(process.argv[3]));
}
