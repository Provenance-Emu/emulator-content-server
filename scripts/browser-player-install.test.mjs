import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadPlayerProfiles } from '../apps/server/dist/src/player-profiles.js';
import { installPinnedPlayer } from './browser-core/install-plugin.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ecs-player-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    registry = join(root, 'registry');
  await mkdir(source);
  await mkdir(registry);
  const loader = Buffer.from('export default async options => ({FS:{},callMain(){}});');
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const descriptor = {
    version: 1,
    id: 'fceumm',
    name: 'Generated installer fixture',
    systems: ['com.provenance.nes'],
    runtime: 'retroarch-emscripten-esm',
    threaded: false,
    filesystem: 'memfs',
    saveCompletion: 'command-reply-v1',
    frontendCommit: '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66',
    coreCommit: 'ac0d00a7fc01166f84c7bac01d1084ebfd2b865e',
    emscriptenVersion: '3.1.46',
    contentExtension: 'nes',
    maxContentBytes: 67108864,
    loader: { file: 'fceumm_libretro.js', sha256: hash(loader) },
    wasm: { file: 'fceumm_libretro.wasm', sha256: hash(wasm) },
  };
  await writeFile(join(source, 'core.json'), JSON.stringify(descriptor));
  await writeFile(join(source, descriptor.loader.file), loader);
  await writeFile(join(source, descriptor.wasm.file), wasm);
  return { source, registry, target: join(registry, 'fceumm'), loader, wasm };
}
test('pinned installation produces an accepted hash-verified plugin snapshot without linking source bytes', async (t) => {
  const f = await fixture(t);
  await installPinnedPlayer(f.source, f.target);
  const catalog = await loadPlayerProfiles(f.registry);
  const player = catalog.items.get('org.libretro.fceumm');
  assert.ok(player);
  assert.deepEqual(player.loader, f.loader);
  assert.deepEqual(player.wasm, f.wasm);
  assert.equal(player.descriptor.saveCompletion, 'command-reply-v1');
  await writeFile(join(f.source, 'fceumm_libretro.js'), 'changed source');
  assert.deepEqual(await readFile(join(f.target, 'loader.js')), f.loader);
  await assert.rejects(installPinnedPlayer(f.source, f.target));
  assert.deepEqual(await readFile(join(f.target, 'loader.js')), f.loader);
});
test('existing installation and invalid input are preserved without partial output', async (t) => {
  const f = await fixture(t);
  await mkdir(f.target);
  await writeFile(join(f.target, 'keep.txt'), 'preserve');
  await assert.rejects(installPinnedPlayer(f.source, f.target), /EEXIST/);
  assert.equal(await readFile(join(f.target, 'keep.txt'), 'utf8'), 'preserve');
  await writeFile(join(f.source, 'fceumm_libretro.wasm'), new Uint8Array([1]));
  const missing = join(f.registry, 'invalid');
  await assert.rejects(installPinnedPlayer(f.source, missing), /player|core/i);
  await assert.rejects(readFile(join(missing, 'plugin.json')), /ENOENT/);
});
