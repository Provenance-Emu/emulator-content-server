import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DomainError } from '@ecs/domain';
import { parseManifest } from '@ecs/plugins';
import type { PlayerCoreResource, WebPlayerDescriptor } from '@ecs/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from './context.js';
import { requireActor } from './http.js';
import { type PlayerAssets, readRegular } from './player-assets.js';

export interface PlayerProfileAssets {
  descriptor: WebPlayerDescriptor;
  loader: Buffer;
  wasm: Buffer;
  assets: ReadonlyMap<string, Buffer>;
}
const MiB = 1024 * 1024;

/** The selected registry itself cannot redirect through a symlink. */
async function directoryWithoutSymlinks(path: string) {
  if (!isAbsolute(path) || !(await lstat(path)).isDirectory()) throw new Error();
}

export async function loadPlayerProfiles(
  directory?: string,
  legacy?: PlayerAssets,
): Promise<{
  items: ReadonlyMap<string, PlayerProfileAssets>;
  defaultProfileId: string | null;
}> {
  const items = new Map<string, PlayerProfileAssets>();
  let totalBytes = 0;
  if (legacy) {
    const d = legacy.descriptor;
    const base = `/play/plugins/${d.id}`;
    items.set(d.id, {
      ...legacy,
      assets: new Map(),
      descriptor: {
        profileVersion: 1,
        id: d.id,
        name: d.name,
        systems: d.systems,
        runtime: d.runtime,
        filesystem: d.filesystem,
        threaded: d.threaded,
        saveCompletion: d.saveCompletion,
        contentExtensions: [d.contentExtension],
        maxContentBytes: d.maxContentBytes,
        buildVersion: `${d.frontendCommit}/${d.coreCommit}/${d.emscriptenVersion}`,
        loader: { ...d.loader, url: `${base}/loader.js` },
        wasm: { ...d.wasm, url: `${base}/core.wasm` },
        assets: [],
      },
    });
    totalBytes = legacy.loader.length + legacy.wasm.length;
  }
  if (directory !== undefined) {
    try {
      await directoryWithoutSymlinks(directory);
      const allEntries = await readdir(directory, { withFileTypes: true });
      if (allEntries.some((entry) => entry.isSymbolicLink())) throw new Error();
      const entries = allEntries.filter((entry) => entry.isDirectory());
      if (entries.length + items.size > 16) throw new Error();
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) throw new Error();
        const root = join(directory, entry.name);
        const manifest = parseManifest(
          JSON.parse((await readRegular(root, 'plugin.json', 64 * 1024)).toString('utf8')),
        );
        const player = manifest.player;
        const web = player?.web;
        if (
          manifest.kind !== 'player' ||
          !player ||
          !web ||
          manifest.entry ||
          items.has(manifest.id)
        )
          throw new Error();
        const base = `/play/plugins/${manifest.id}`;
        const read = async (spec: { file: string; sha256: string }, cap: number, url: string) => {
          const bytes = await readRegular(root, spec.file, Math.min(cap, 256 * MiB - totalBytes));
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          if (sha256 !== spec.sha256) throw new Error();
          totalBytes += bytes.length;
          if (totalBytes > 256 * MiB) throw new Error();
          return { bytes, resource: { url, sha256, sizeBytes: bytes.length } };
        };
        const loader = await read(web.loader, 8 * MiB, `${base}/loader.js`);
        const wasm = await read(web.wasm, 64 * MiB, `${base}/core.wasm`);
        if (!wasm.bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])))
          throw new Error();
        const assets = new Map<string, Buffer>();
        const assetResources = [];
        let assetBytes = 0;
        for (const spec of web.assets) {
          const asset = await read(spec, 32 * MiB - assetBytes, `${base}/assets/${spec.name}`);
          assetBytes += asset.bytes.length;
          if (assetBytes > 32 * MiB) throw new Error();
          assets.set(spec.name, asset.bytes);
          assetResources.push({ name: spec.name, ...asset.resource });
        }
        items.set(manifest.id, {
          loader: loader.bytes,
          wasm: wasm.bytes,
          assets,
          descriptor: {
            profileVersion: 1,
            id: manifest.id,
            name: manifest.name,
            systems: player.systems,
            runtime: web.runtime,
            filesystem: web.filesystem,
            threaded: web.threaded,
            saveCompletion: web.saveCompletion,
            contentExtensions: web.contentExtensions,
            maxContentBytes: web.maxContentBytes,
            buildVersion: web.buildVersion,
            loader: loader.resource,
            wasm: wasm.resource,
            assets: assetResources,
          },
        });
      }
    } catch {
      // Never expose filesystem errors, manifest values, or private operator paths.
      throw new Error(
        'Invalid player plugin configuration: unsupported profile or unreadable, unsafe, oversized, or hash-mismatched files',
      );
    }
  }
  const sorted = new Map([...items].sort(([a], [b]) => a.localeCompare(b)));
  return {
    items: sorted,
    defaultProfileId: legacy?.descriptor.id ?? sorted.keys().next().value ?? null,
  };
}

function requireRead(request: FastifyRequest) {
  const actor = requireActor(request);
  if (!(actor.kind === 'user' ? actor.scopes : actor.capabilities).includes('read'))
    throw new DomainError('forbidden', 403, 'Read permission is required');
}
export function registerPlayerProfiles(app: FastifyInstance, context: ServerContext) {
  const profile = (id: string) => {
    const player = context.playerProfiles.get(id);
    if (!player) throw new DomainError('not-found', 404, 'Browser player is not available');
    return player;
  };
  app.get('/api/v1/player/profiles', async (request, reply) => {
    requireRead(request);
    reply.header('cache-control', 'private, no-store');
    return {
      items: [...context.playerProfiles.values()].map((p) => p.descriptor),
      defaultProfileId: context.defaultPlayerProfileId,
    };
  });
  app.get<{ Params: { id: string } }>('/api/v1/player/profiles/:id', async (request, reply) => {
    requireRead(request);
    reply.header('cache-control', 'private, no-store');
    return profile(request.params.id).descriptor;
  });
  const send = (
    reply: import('fastify').FastifyReply,
    bytes: Buffer,
    resource: PlayerCoreResource,
    mime: string,
  ) =>
    reply
      .type(mime)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'same-origin')
      .header('etag', `"${resource.sha256}"`)
      .send(bytes);
  for (const [file, key, mime] of [
    ['loader.js', 'loader', 'text/javascript'],
    ['core.wasm', 'wasm', 'application/wasm'],
  ] as const) {
    app.get<{ Params: { id: string } }>(`/play/plugins/:id/${file}`, async (request, reply) => {
      requireRead(request);
      const p = profile(request.params.id);
      return send(reply, p[key], p.descriptor[key], mime);
    });
  }
  app.get<{ Params: { id: string; name: string } }>(
    '/play/plugins/:id/assets/:name',
    async (request, reply) => {
      requireRead(request);
      const p = profile(request.params.id);
      const bytes = p.assets.get(request.params.name);
      const resource = p.descriptor.assets.find((a) => a.name === request.params.name);
      if (!bytes || !resource)
        throw new DomainError('not-found', 404, 'Browser player asset is not available');
      return send(reply, bytes, resource, 'application/octet-stream');
    },
  );
}
