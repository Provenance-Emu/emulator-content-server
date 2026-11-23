import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManifestFile, SourceFile } from '@ecs/client';
import type { PlayerClient } from '../src/player/controller.js';
import { collectFirmware } from '../src/player/firmware.js';
import type { BrowserCore } from '../src/player/runtime.js';

const core = { id: 'org.flycast.wasm-jit', systems: ['com.provenance.dreamcast'] } as BrowserCore;
const bios = 2 * 1024 ** 2;
const source = (id: string, size: number, contentPath: string): SourceFile =>
  ({
    id,
    rootId: 'root',
    libraryId: 'library',
    name: 'dc_boot.bin',
    kind: 'bios',
    size,
    availability: 'local',
    contentPath,
  }) as SourceFile;

function client(collected: string[]): PlayerClient {
  return {
    async collectSource(id: string, options: { maxBytes: number }) {
      collected.push(id);
      return { bytes: new Uint8Array(options.maxBytes) };
    },
  } as unknown as PlayerClient;
}

test('a library with several copies of a system file still starts, on the same copy each time', async () => {
  for (const sources of [
    [source('b', bios, 'bios/b/dc_boot.bin'), source('a', bios, 'bios/a/dc_boot.bin')],
    [source('a', bios, 'bios/a/dc_boot.bin'), source('b', bios, 'bios/b/dc_boot.bin')],
  ]) {
    const collected: string[] = [];
    const files = await collectFirmware(client(collected), core, {
      system: 'com.provenance.dreamcast',
      libraryId: 'library',
      files: [],
      sources,
    });
    assert.deepEqual(collected, ['a']);
    assert.equal(files[0]?.path, '/ecs/system/dc/dc_boot.bin');
  }
});

test('a copy of the wrong size is passed over for one that fits', async () => {
  const collected: string[] = [];
  await collectFirmware(client(collected), core, {
    system: 'com.provenance.dreamcast',
    libraryId: 'library',
    files: [],
    sources: [source('a', 1024, 'a/dc_boot.bin'), source('b', bios, 'b/dc_boot.bin')],
  });
  assert.deepEqual(collected, ['b']);
});

test('several copies attached to the game do not stop it either', async () => {
  const collected: string[] = [];
  const attached = (id: string): ManifestFile =>
    ({ id, kind: 'bios', relativePath: `${id}/dc_boot.bin`, size: bios }) as ManifestFile;
  await collectFirmware(
    {
      async collect(id: string, options: { maxBytes: number }) {
        collected.push(id);
        return { bytes: new Uint8Array(options.maxBytes) };
      },
    } as unknown as PlayerClient,
    core,
    {
      system: 'com.provenance.dreamcast',
      libraryId: 'library',
      files: [attached('y'), attached('x')],
    },
  );
  assert.deepEqual(collected, ['x']);
});
