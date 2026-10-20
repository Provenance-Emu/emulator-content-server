import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DomainError } from '@ecs/domain';
import type { PlayerCoreDescriptor } from '@ecs/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from './context.js';
import { requireActor } from './http.js';

const LOADER = 'fceumm_libretro.js';
const WASM = 'fceumm_libretro.wasm';
const FRONTEND_COMMIT = '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66';
const CORE_COMMIT = 'ac0d00a7fc01166f84c7bac01d1084ebfd2b865e';

export interface PlayerAssets {
  descriptor: PlayerCoreDescriptor;
  loader: Buffer;
  wasm: Buffer;
}

/** Never imports operator code. All exposed bytes are bounded startup snapshots. */
export async function loadPlayerAssets(directory: string): Promise<PlayerAssets> {
  try {
    if (!isAbsolute(directory)) throw new Error('player directory must be absolute');
    const root = await realpath(directory);
    const names = (await readdir(root)).sort();
    if (JSON.stringify(names) !== JSON.stringify(['core.json', LOADER, WASM].sort())) {
      throw new Error(
        'player directory must contain only core.json and the supported loader/WASM pair',
      );
    }
    const manifest: unknown = JSON.parse(
      (await readRegular(root, 'core.json', 64 * 1024)).toString('utf8'),
    );
    const m = object(manifest);
    if (
      m.version !== 1 ||
      typeof m.id !== 'string' ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(m.id) ||
      typeof m.name !== 'string' ||
      !/^[\x20-\x7e]{1,80}$/.test(m.name) ||
      !m.name.trim() ||
      JSON.stringify(m.systems) !== '["com.provenance.nes"]' ||
      m.runtime !== 'retroarch-emscripten-esm' ||
      m.threaded !== false ||
      m.filesystem !== 'memfs' ||
      m.saveCompletion !== 'command-reply-v1' ||
      m.frontendCommit !== FRONTEND_COMMIT ||
      m.coreCommit !== CORE_COMMIT ||
      m.emscriptenVersion !== '3.1.46' ||
      m.contentExtension !== 'nes' ||
      !Number.isSafeInteger(m.maxContentBytes) ||
      Number(m.maxContentBytes) <= 0 ||
      Number(m.maxContentBytes) > 64 * 1024 * 1024
    ) {
      throw new Error('unsupported player core descriptor/profile');
    }
    const loader = await artifact(root, object(m.loader), LOADER, 8 * 1024 * 1024);
    const wasm = await artifact(root, object(m.wasm), WASM, 64 * 1024 * 1024);
    if (!wasm.bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
      throw new Error('invalid player core WASM header');
    }
    return {
      descriptor: {
        version: 1,
        id: m.id,
        name: m.name,
        systems: ['com.provenance.nes'],
        runtime: 'retroarch-emscripten-esm',
        threaded: false,
        filesystem: 'memfs',
        saveCompletion: 'command-reply-v1',
        frontendCommit: FRONTEND_COMMIT,
        coreCommit: CORE_COMMIT,
        emscriptenVersion: '3.1.46',
        contentExtension: 'nes',
        maxContentBytes: Number(m.maxContentBytes),
        loader: {
          url: `/play/cores/${m.id}/loader.js`,
          sha256: loader.sha256,
          sizeBytes: loader.bytes.length,
        },
        wasm: {
          url: `/play/cores/${m.id}/core.wasm`,
          sha256: wasm.sha256,
          sizeBytes: wasm.bytes.length,
        },
      },
      loader: loader.bytes,
      wasm: wasm.bytes,
    };
  } catch (error) {
    // Filesystem errors and JSON contents can contain private operator paths/data.
    const detail =
      error instanceof Error && !('code' in error) && !(error instanceof SyntaxError)
        ? error.message
        : 'missing, unreadable, or invalid core files';
    throw new Error(`Invalid player configuration: ${detail}`);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid player core descriptor');
  return value as Record<string, unknown>;
}

async function artifact(root: string, spec: Record<string, unknown>, file: string, cap: number) {
  if (
    spec.file !== file ||
    typeof spec.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(spec.sha256)
  ) {
    throw new Error('invalid player core filename or SHA-256');
  }
  const bytes = await readRegular(root, file, cap);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== spec.sha256) throw new Error('player core SHA-256 mismatch');
  return { bytes, sha256 };
}

async function readRegular(root: string, file: string, cap: number): Promise<Buffer> {
  const path = join(root, file);
  if (!(await lstat(path)).isFile())
    throw new Error('player core files must be regular files, not symlinks');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > cap)
      throw new Error('player core file exceeds size limit or is empty');
    // A growing file can never make readFile allocate an unbounded buffer.
    const bytes = Buffer.alloc(stat.size + 1);
    let received = 0;
    while (received < bytes.length) {
      const read = await handle.read(bytes, received, bytes.length - received, received);
      if (!read.bytesRead) break;
      received += read.bytesRead;
    }
    if (received !== stat.size) throw new Error('player core file changed during startup');
    return bytes.subarray(0, received);
  } finally {
    await handle.close();
  }
}

function requireRead(request: FastifyRequest): void {
  const actor = requireActor(request);
  const permissions = actor.kind === 'user' ? actor.scopes : actor.capabilities;
  if (!permissions.includes('read'))
    throw new DomainError('forbidden', 403, 'Read permission is required');
}

export function registerPlayerAssets(app: FastifyInstance, context: ServerContext): void {
  app.get('/api/v1/player/core', async (request, reply) => {
    if (!context.player)
      throw new DomainError('not-found', 404, 'Browser playback is not configured');
    requireRead(request);
    reply.header('cache-control', 'private, no-store');
    return context.player.descriptor;
  });
  for (const [name, key, mime] of [
    ['loader.js', 'loader', 'text/javascript'],
    ['core.wasm', 'wasm', 'application/wasm'],
  ] as const) {
    app.get<{ Params: { coreId: string } }>(
      `/play/cores/:coreId/${name}`,
      async (request, reply) => {
        const player = context.player;
        if (!player || request.params.coreId !== player.descriptor.id)
          throw new DomainError('not-found', 404, 'Browser core is not available');
        requireRead(request);
        return reply
          .type(mime)
          .header('cache-control', 'private, no-store')
          .header('x-content-type-options', 'nosniff')
          .header('cross-origin-resource-policy', 'same-origin')
          .header('etag', `"${player.descriptor[key].sha256}"`)
          .send(player[key]);
      },
    );
  }
}
