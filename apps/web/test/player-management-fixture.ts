import { createHash } from 'node:crypto';
import type { PlayerManagement, WebPlayerDescriptor } from '@ecs/client';

export function playerProfile(id: string, name = id): WebPlayerDescriptor {
  return {
    profileVersion: 1,
    id,
    name,
    systems: ['com.provenance.nes'],
    runtime: 'emscripten-esm-v1',
    filesystem: 'memfs',
    threaded: false,
    saveCompletion: 'none',
    contentExtensions: ['nes'],
    maxContentBytes: 1024,
    buildVersion: '1.0',
    loader: { url: `/play/profiles/${id}/loader.js`, sha256: '0'.repeat(64), sizeBytes: 4 },
    wasm: { url: `/play/profiles/${id}/core.wasm`, sha256: '0'.repeat(64), sizeBytes: 4 },
    assets: [],
  };
}

export function playerManagementFixture(): PlayerManagement {
  return {
    items: [
      {
        profile: playerProfile('managed', 'Console emulator'),
        enabled: true,
        source: 'managed',
        removable: true,
      },
      {
        profile: playerProfile('operator', 'Server emulator'),
        enabled: true,
        source: 'operator',
        removable: false,
      },
      {
        profile: playerProfile('disabled', 'Extra emulator'),
        enabled: false,
        source: 'managed',
        removable: true,
      },
    ],
    defaultProfileId: 'managed',
    available: [
      {
        id: 'supported',
        name: 'Handheld emulator',
        systems: ['com.provenance.gba'],
        description: 'A generated browser-compatible emulator catalog entry.',
        available: true,
        reason: null,
        downloadBytes: 16384,
      },
      {
        id: 'unsupported',
        name: 'Disc emulator',
        systems: ['com.provenance.segacd'],
        description: 'A generated unavailable catalog entry.',
        available: false,
        reason: 'This emulator does not support the browser runtime.',
        downloadBytes: null,
      },
    ],
  };
}

/** A generated non-emulating runtime package, never a ROM or downloaded core. */
export function playerPackageFixture() {
  const id = 'org.example.native-import';
  const loader = Buffer.from('export default async()=>({FS:{},callMain(){}});');
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const manifest = {
    id,
    name: 'Imported emulator',
    kind: 'player',
    version: '1',
    engine: 'ecs.plugin/1',
    apps: ['org.example.test'],
    player: {
      systems: ['com.provenance.nes'],
      module: 'core.wasm',
      web: {
        profileVersion: 1,
        runtime: 'emscripten-esm-v1',
        filesystem: 'memfs',
        threaded: false,
        saveCompletion: 'none',
        contentExtensions: ['nes'],
        maxContentBytes: 1024,
        buildVersion: 'generated',
        loader: { file: 'loader.js', sha256: hash(loader) },
        wasm: { file: 'core.wasm', sha256: hash(wasm) },
        assets: [],
      },
    },
  };
  const header = Buffer.from(
    JSON.stringify({
      manifest,
      files: [
        { name: 'loader.js', size: loader.length },
        { name: 'core.wasm', size: wasm.length },
      ],
    }),
  );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length);
  return { id, bytes: Buffer.concat([prefix, header, loader, wasm]) };
}
