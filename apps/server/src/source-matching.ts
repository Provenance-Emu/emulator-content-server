import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { type Actor, DomainError } from '@ecs/domain';
import { normalizeCheats } from '@ecs/plugins/cheats';
import {
  type MatchCandidate,
  type MatchCompanion,
  type MatchingInput,
  patchFingerprint,
} from '@ecs/plugins/matching';
import { type MatchingPluginDescription, matchingJob } from '@ecs/plugins/matching-host';
import { crc32Hex } from '@ecs/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from './context.js';
import { requireOwner } from './http.js';
import { boundedFile, imageType } from './matching-files.js';
import { localSource, visibleSource } from './source-groups.js';
import { sourceMetadata } from './source-metadata.js';
import { registerSourceSelections } from './source-selections.js';

function matchBody(value: unknown): {
  online: boolean;
  checksum: boolean;
  providerIds?: string[];
  managerId?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DomainError('invalid-request', 400, 'Expected matching options');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['online', 'checksum', 'providerIds', 'managerId'].includes(key),
    ) ||
    ['online', 'checksum'].some(
      (key) => record[key] !== undefined && typeof record[key] !== 'boolean',
    )
  )
    throw new DomainError('invalid-request', 400, 'Invalid matching options');
  const identifier = (id: unknown): id is string =>
    typeof id === 'string' && id.length <= 120 && /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(id);
  if (
    record.providerIds !== undefined &&
    (!Array.isArray(record.providerIds) ||
      record.providerIds.length > 32 ||
      record.providerIds.some((id) => !identifier(id)) ||
      new Set(record.providerIds).size !== record.providerIds.length)
  )
    throw new DomainError('invalid-request', 400, 'Invalid providers');
  if (record.managerId !== undefined && !identifier(record.managerId))
    throw new DomainError('invalid-request', 400, 'Invalid manager');
  return {
    online: record.online === true,
    checksum: record.checksum === true,
    ...(record.providerIds ? { providerIds: record.providerIds as string[] } : {}),
    ...(record.managerId ? { managerId: record.managerId as string } : {}),
  };
}

export function registerSourceMatching(app: FastifyInstance, context: ServerContext): void {
  type Job = {
    sourceId: string;
    ownerId: string;
    expires: number;
    candidates: (MatchCandidate & { providerId: string })[];
    stamps: Map<string, string>;
  };
  const jobs = new Map<string, Job>();
  const abort = new AbortController();
  let active = 0;
  let listing: Promise<MatchingPluginDescription[]> | null = null;
  let pluginList: { expires: number; plugins: MatchingPluginDescription[] } | null = null;
  app.addHook('preClose', async () => {
    abort.abort();
    jobs.clear();
  });
  async function plugins(): Promise<MatchingPluginDescription[]> {
    if (pluginList && pluginList.expires >= Date.now()) return pluginList.plugins;
    if (listing) return listing;
    listing = matchingJob(
      {
        operation: 'list',
        ...(context.matchingPluginsDir ? { directory: context.matchingPluginsDir } : {}),
      },
      { signal: abort.signal },
    )
      .then((result) => {
        pluginList = { expires: Date.now() + 60000, plugins: result.plugins };
        return result.plugins;
      })
      .finally(() => {
        listing = null;
      });
    return listing;
  }
  app.get('/api/v1/matching/plugins', async (request, reply) => {
    requireOwner(request, 'Only the server owner can manage matching');
    reply.header('cache-control', 'private, no-store');
    return { plugins: await plugins() };
  });
  app.post('/api/v1/sources/:sourceId/matches', async (request, reply) => {
    const actor = requireOwner(request, 'Only the server owner can run matching');
    const source = visibleSource(context, actor, (request.params as { sourceId: string }).sourceId);
    const options = matchBody(request.body ?? {});
    if (active >= 2)
      throw new DomainError(
        'matching-busy',
        429,
        'Two matching jobs are already running. Try again shortly.',
      );
    active++;
    const cancelled = new AbortController();
    const disconnect = () => {
      if (!reply.raw.writableEnded) cancelled.abort();
    };
    reply.raw.once('close', disconnect);
    const signal = AbortSignal.any([abort.signal, cancelled.signal]);
    try {
      const available = await plugins();
      if (
        options.providerIds?.some(
          (id) => !available.some((p) => p.id === id && p.kind === 'provider'),
        ) ||
        (options.managerId &&
          !available.some((p) => p.id === options.managerId && p.kind === 'manager'))
      )
        throw new DomainError('invalid-request', 400, 'Unknown matching plugin');
      const stamps = new Map<string, string>();
      try {
        stamps.set(source.id, await stamp(actor, source.id));
      } catch {
        /* Offline lookups can show filename hints, but cannot be saved as current. */
      }
      const input: MatchingInput = {
        name: source.displayName,
        systemId: source.systemId,
        online: options.online,
        companions: [],
        size: source.size,
      };
      const directory = posix.dirname(source.relativePath);
      const stem = source.displayName
        .replace(/\.[^.]+$/, '')
        .normalize('NFC')
        .toLowerCase();
      const files = context.catalog.listSources(source.rootId, 50001);
      if (files.length > 50000)
        throw new DomainError(
          'matching-folder-too-large',
          413,
          'This folder exceeds the matching index limit',
        );
      const companions = files
        .filter((file) => {
          const parent = posix.dirname(file.relativePath);
          return (
            file.id !== source.id &&
            [
              directory,
              ...['artwork', 'boxart', 'covers', 'patches', 'metadata', 'cheats'].map((name) =>
                posix.join(directory, name),
              ),
            ].includes(parent) &&
            ((options.checksum && /\.(bps|ups)$/i.test(file.displayName)) ||
              file.displayName
                .replace(/\.[^.]+$/, '')
                .replace(/(?:[ ._-](?:cover|boxart|front))$/i, '')
                .replace(
                  /\s+\((?:Game Genie|Action Replay|Pro Action Replay|GameShark|CodeBreaker)\)$/i,
                  '',
                )
                .normalize('NFC')
                .toLowerCase() === stem)
          );
        })
        .slice(0, 100);
      for (const file of companions) {
        visibleSource(context, actor, file.id);
        const companion: MatchCompanion = { id: file.id, name: file.displayName };
        if (file.availability !== 'local') continue;
        try {
          stamps.set(file.id, await stamp(actor, file.id));
          if (/\.cht$/i.test(file.displayName)) {
            const local = await localSource(context, actor, file.id);
            companion.cheats = {
              count: normalizeCheats(await boundedFile(local.path, 256 * 1024)).count,
            };
          } else if (/\.json$/i.test(file.displayName)) {
            const local = await localSource(context, actor, file.id);
            const data: unknown = JSON.parse(
              (await boundedFile(local.path, 64 * 1024)).toString('utf8'),
            );
            if (data && typeof data === 'object' && !Array.isArray(data)) {
              const metadata = Object.fromEntries(
                Object.entries(data).filter(
                  ([key, value]) =>
                    [
                      'title',
                      'description',
                      'developer',
                      'publisher',
                      'year',
                      'genre',
                      'region',
                    ].includes(key) &&
                    typeof value === 'string' &&
                    value.length > 0 &&
                    value.length <= 4096,
                ),
              );
              if (Object.keys(metadata).length)
                companion.metadata = metadata as Record<string, string>;
            }
          } else if (/\.(bps|ups|ips)$/i.test(file.displayName)) {
            const local = await localSource(context, actor, file.id);
            const fingerprint = patchFingerprint(await boundedFile(local.path, 256 * 1024));
            if (fingerprint) companion.patch = fingerprint;
          }
          input.companions.push(companion);
        } catch {
          /* An invalid or unavailable sidecar does not stop the game's other matches. */
        }
      }
      if (options.checksum) {
        if (
          source.groupMembers?.length ||
          /\.(zip|7z|chd|cdi|iso|cue|m3u|gdi|ccd)$/i.test(source.displayName)
        )
          throw new DomainError(
            'matching-container-checksum',
            400,
            'Container checksums do not identify the ROM inside. Use filename matching for this entry.',
          );
        const local = await localSource(context, actor, source.id);
        const bytes = await boundedFile(local.path, 64 * 1024 * 1024);
        input.md5 = createHash('md5').update(bytes).digest('hex');
        input.crc32 = crc32Hex(bytes);
        input.size = bytes.length;
      }
      const result = await matchingJob(
        {
          operation: 'match',
          input,
          ...(context.matchingPluginsDir ? { directory: context.matchingPluginsDir } : {}),
          ...(options.providerIds ? { providerIds: options.providerIds } : {}),
          ...(options.managerId ? { managerId: options.managerId } : {}),
        },
        { signal },
      );
      const knownFiles = new Set(input.companions.map((file) => file.id));
      const badProviders = new Set(
        (result.result?.candidates ?? [])
          .filter((c) => c.fileId && !knownFiles.has(c.fileId))
          .map((c) => c.providerId),
      );
      const problems = [
        ...(result.result?.problems ?? []),
        ...Array.from(badProviders, (providerId) => ({ providerId, code: 'provider-failed' })),
      ];
      const candidates = (result.result?.candidates ?? [])
        .filter((c) => !badProviders.has(c.providerId))
        .map((candidate) => ({ ...candidate, id: randomUUID() }));
      for (const [id, job] of jobs) if (job.expires < Date.now()) jobs.delete(id);
      while (jobs.size >= 128) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        jobs.delete(oldest);
      }
      const requestId = randomUUID();
      jobs.set(requestId, {
        sourceId: source.id,
        ownerId: actor.userId,
        expires: Date.now() + 15 * 60000,
        candidates,
        stamps,
      });
      reply.header('cache-control', 'private, no-store');
      return { sourceId: source.id, requestId, plugins: result.plugins, candidates, problems };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'matching-unavailable',
        503,
        'Matching is unavailable. Check the installed provider and manager plugins.',
      );
    } finally {
      active--;
      reply.raw.removeListener('close', disconnect);
    }
  });

  async function stamp(actor: Actor, id: string): Promise<string> {
    const file = await localSource(context, actor, id);
    return (await sourceMetadata(file.path, id)).etag;
  }
  function proposal(sourceId: string, ownerId: string, requestId: string, candidateId: string) {
    const job = jobs.get(requestId);
    const candidate = job?.candidates.find((c) => c.id === candidateId);
    if (
      !job ||
      job.sourceId !== sourceId ||
      job.ownerId !== ownerId ||
      job.expires < Date.now() ||
      !candidate
    )
      throw new DomainError('not-found', 404, 'Matching request expired; find matches again');
    return {
      candidate,
      async validate(actor: Actor) {
        for (const id of [sourceId, ...(candidate.fileId ? [candidate.fileId] : [])]) {
          if (!job.stamps.has(id) || job.stamps.get(id) !== (await stamp(actor, id)))
            throw new DomainError(
              'matching-source-changed',
              409,
              'Source or companion changed. Find matches again before saving.',
            );
        }
      },
    };
  }
  async function resource(
    candidate: MatchCandidate & { providerId: string },
    sourceId: string,
    actor: Actor,
    _request: FastifyRequest,
    reply: FastifyReply,
  ) {
    if (active >= 2)
      throw new DomainError(
        'matching-busy',
        429,
        'Two matching jobs are already running. Try again shortly.',
      );
    active++;
    const cancelled = new AbortController();
    const disconnect = () => {
      if (!reply.raw.writableEnded) cancelled.abort();
    };
    reply.raw.once('close', disconnect);
    try {
      let bytes: Buffer;
      let fileName: string;
      let originKind: import('@ecs/domain').AssetKind | null = null;
      if (candidate.fileId) {
        const file = await localSource(context, actor, candidate.fileId);
        if (file.source.rootId !== visibleSource(context, actor, sourceId).rootId)
          throw new DomainError('not-found', 404, 'Selected companion unavailable');
        bytes = await boundedFile(
          file.path,
          candidate.kind === 'artwork' ? 2 * 1024 * 1024 : 256 * 1024,
        );
        fileName = file.source.displayName;
        originKind = file.source.kind;
      } else {
        const artwork =
          candidate.kind === 'artwork' &&
          candidate.providerId === 'org.ecs.libretro' &&
          candidate.url?.startsWith('https://raw.githubusercontent.com/libretro-thumbnails/');
        const cheats =
          candidate.kind === 'cheats' &&
          candidate.providerId === 'org.ecs.cheats.libretro' &&
          candidate.url?.startsWith(
            'https://raw.githubusercontent.com/libretro/libretro-database/master/cht/',
          );
        if (!candidate.url || (!artwork && !cheats))
          throw new DomainError(
            'matching-resource-unavailable',
            404,
            'This provider does not supply downloadable content',
          );
        try {
          const fetched = await matchingJob(
            { operation: artwork ? 'artwork' : 'cheats', artworkUrl: candidate.url },
            { signal: AbortSignal.any([abort.signal, cancelled.signal]) },
          );
          const encoded = artwork ? fetched.artwork : fetched.file;
          if (!encoded) throw new Error('Missing content');
          bytes = Buffer.from(encoded, 'base64');
          fileName = decodeURIComponent(
            new URL(candidate.url).pathname.split('/').at(-1) ?? 'selected',
          );
        } catch {
          throw new DomainError(
            artwork ? 'artwork-unavailable' : 'cheats-unavailable',
            404,
            'Selected content is unavailable from this provider',
          );
        }
      }
      let contentType = 'application/octet-stream';
      if (candidate.kind === 'artwork') {
        const type = imageType(bytes);
        if (!type)
          throw new DomainError(
            'unsupported-artwork',
            415,
            'Artwork is not a supported raster image',
          );
        contentType = type;
      } else if (candidate.kind === 'cheats') {
        try {
          bytes = Buffer.from(normalizeCheats(bytes).text);
        } catch {
          throw new DomainError('unsupported-cheats', 415, 'Cheat file is invalid or unsupported');
        }
        contentType = 'text/plain; charset=utf-8';
      } else if (candidate.kind === 'patch' && !patchFingerprint(bytes))
        throw new DomainError('unsupported-patch', 415, 'Patch file is invalid or changed');
      return { bytes, contentType, fileName, originKind };
    } finally {
      active--;
      reply.raw.removeListener('close', disconnect);
    }
  }
  registerSourceSelections(app, context, { proposal, resource });
  app.get(
    '/api/v1/sources/:sourceId/matches/:requestId/artwork/:candidateId',
    async (request, reply) => {
      const actor = requireOwner(request, 'Only the server owner can preview matching artwork');
      const params = request.params as { sourceId: string; requestId: string; candidateId: string };
      visibleSource(context, actor, params.sourceId);
      const selected = proposal(
        params.sourceId,
        actor.userId,
        params.requestId,
        params.candidateId,
      );
      if (selected.candidate.kind !== 'artwork')
        throw new DomainError('not-found', 404, 'Artwork not found');
      const content = await resource(selected.candidate, params.sourceId, actor, request, reply);
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      return reply.type(content.contentType).send(content.bytes);
    },
  );
}
