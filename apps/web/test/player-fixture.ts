import type {
  Asset,
  Item,
  Manifest,
  PlayerCoreDescriptor,
  SourceFile,
  UploadRequest,
} from '@ecs/client';
import type { PlayerClient } from '../src/player/controller.js';
import type { PlayerRuntime, RuntimeOptions } from '../src/player/runtime.js';
export function fixture() {
  const core: PlayerCoreDescriptor = {
    version: 1,
    id: 'fceumm',
    name: 'FCEUmm',
    systems: ['com.provenance.nes'],
    runtime: 'retroarch-emscripten-esm',
    threaded: false,
    filesystem: 'memfs',
    saveCompletion: 'command-reply-v1',
    frontendCommit: '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66',
    coreCommit: 'ac0d00a7fc01166f84c7bac01d1084ebfd2b865e',
    emscriptenVersion: '3.1.46',
    contentExtension: 'nes',
    maxContentBytes: 1024,
    loader: { url: '/play/cores/fceumm/loader.js', sha256: 'a'.repeat(64), sizeBytes: 24 },
    wasm: { url: '/play/cores/fceumm/core.wasm', sha256: 'b'.repeat(64), sizeBytes: 8 },
  };
  const item: Item = {
    id: 'item',
    libraryId: 'library',
    systemIdentifier: 'com.provenance.nes',
    title: 'Same title',
    revision: 7,
    md5: null,
    crc: null,
    createdAt: '',
    updatedAt: '',
  };
  const manifest: Manifest = {
    version: 1,
    itemId: 'item',
    revision: 7,
    files: [
      {
        id: 'rom',
        kind: 'rom',
        relativePath: 'display-name.nes',
        sha256: '',
        size: 3,
        required: true,
        contentPath: '',
        md5: null,
        crc: null,
      },
      {
        id: 'battery',
        kind: 'battery_save',
        relativePath: 'original.sav',
        sha256: '',
        size: 2,
        required: false,
        contentPath: '',
        md5: null,
        crc: null,
      },
      {
        id: 'state',
        kind: 'save_state',
        relativePath: 'original.state',
        sha256: '',
        size: 2,
        required: false,
        contentPath: '',
        md5: null,
        crc: null,
      },
    ],
  };
  const source: SourceFile = {
    id: 'source',
    rootId: 'root',
    libraryId: 'library',
    name: 'display-name.nes',
    kind: 'rom',
    size: 3,
    systemId: 'com.provenance.nes',
    availability: 'local',
    medium: 'local',
    contentPath: '',
  };
  const events: string[] = [];
  const fs = new Map<string, Uint8Array>();
  const replies: string[] = [];
  const uploads: UploadRequest[] = [];
  let options: RuntimeOptions | undefined;
  const runtime: PlayerRuntime = {
    FS: {
      mkdirTree(path) {
        events.push(`mkdir:${path}`);
      },
      writeFile(path, bytes) {
        events.push(`write:${path}`);
        fs.set(path, bytes.slice());
      },
      readFile(path) {
        events.push(`read:${path}`);
        const bytes = fs.get(path);
        if (!bytes) throw new Error('missing file');
        return bytes;
      },
    },
    callMain() {
      events.push('main');
    },
    EmscriptenSendCommand(command) {
      events.push(command);
      replies.push(command === 'SAVE_FILES' ? 'OK\n' : command);
    },
    EmscriptenReceiveCommandReply() {
      return replies.shift();
    },
  };
  const bodies: Record<string, Uint8Array<ArrayBuffer>> = {
    rom: new Uint8Array([1, 2, 3]),
    battery: new Uint8Array([4, 5]),
    state: new Uint8Array([6, 7]),
  };
  const client: PlayerClient = {
    async capabilities() {
      return { features: { webPlayback: true } } as Awaited<
        ReturnType<PlayerClient['capabilities']>
      >;
    },
    async playerCore() {
      return core;
    },
    async playerCoreAssets() {
      events.push('core-bytes');
      return {
        loader: { bytes: new TextEncoder().encode('export default ()=>({});'), etag: null },
        wasm: { bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), etag: null },
      };
    },
    async libraries() {
      return {
        items: [{ id: 'library', name: 'Library', ownerId: 'owner', revision: 1, createdAt: '' }],
        nextCursor: null,
      };
    },
    async items() {
      return { items: [item], nextCursor: null };
    },
    async sources() {
      return { items: [source] };
    },
    async manifest() {
      return manifest;
    },
    async collect(id) {
      events.push(`collect:${id}`);
      return { bytes: bodies[id] ?? new Uint8Array(), etag: null };
    },
    async collectSource() {
      events.push('collect:source');
      return { bytes: bodies.rom ?? new Uint8Array(), etag: null };
    },
    async upload(request) {
      uploads.push(request);
      return { id: 'saved', conflictOf: null, revision: 300 } as Asset;
    },
  };
  const importer = async () => {
    events.push('import');
    return {
      factory: async (o: RuntimeOptions) => {
        options = o;
        events.push('factory');
        return runtime;
      },
      release() {
        events.push('release');
      },
    };
  };
  return {
    core,
    item,
    manifest,
    source,
    events,
    fs,
    replies,
    uploads,
    runtime,
    bodies,
    client,
    importer,
    options: () => options,
  };
}
