import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { DomainError, type SourceFileRecord } from '@ecs/domain';
import { PROVENANCE_SYSTEMS } from '@ecs/protocol';
import {
  applyOrganization,
  type OrganizationPlan,
  portableSegment,
  previewOrganization,
  probeRoot,
} from '@ecs/storage';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './context.js';
import { jsonObject, requiredString, requireOwner } from './http.js';
import { reserveContentRoots } from './root-mutations.js';
import { localSource } from './source-groups.js';

// Deliberately excludes archives, descriptors, tracks and disc images. A future
// grouped operation must preview every companion before supporting those files.
const RAW_ROM =
  /\.(nes|sfc|smc|n64|z64|v64|gba|gb|gbc|nds|sms|gg|md|gen|a26|a52|a78|lnx|j64|jag|pce|ws|wsc|ngp|ngc|vb)$/i;
const TTL = 10 * 60 * 1000;
interface SavedPlan {
  ownerId: string;
  sourceId: string;
  targetRootId: string;
  snapshot: string;
  expiresAt: number;
  operation: OrganizationPlan;
}
function stale(): never {
  throw new DomainError(
    'organization-conflict',
    409,
    'The organization preview changed or expired. Preview again.',
  );
}

export function registerSourceOrganization(app: FastifyInstance, context: ServerContext): void {
  const { catalog } = context;
  const plans = new Map<string, SavedPlan>();
  const busy = new Set<string>();
  const snapshot = (source: SourceFileRecord) =>
    JSON.stringify({ source, matches: catalog.sourceMatches(source.id) });
  const eligible = (source: SourceFileRecord) => {
    if (
      source.kind !== 'rom' ||
      !RAW_ROM.test(source.displayName) ||
      source.groupAnchor ||
      source.groupError ||
      source.groupMembers?.length ||
      catalog
        .listSources(source.rootId)
        .some(
          (other) => other.id !== source.id && other.groupMembers?.includes(source.relativePath),
        )
    )
      throw new DomainError(
        'organization-unsupported',
        409,
        'Only a single local cartridge ROM can be organized. Disc sets, archives, descriptors and companion files are not supported.',
      );
  };
  app.post('/api/v1/sources/:sourceId/organization/preview', async (request) => {
    const actor = requireOwner(request, 'Only an owner can organize original files');
    const sourceId = (request.params as { sourceId: string }).sourceId;
    const body = jsonObject(request.body);
    if (Object.keys(body).some((key) => !['mode', 'targetRootId'].includes(key)))
      throw new DomainError('invalid-body', 400, 'Only mode and targetRootId are accepted');
    const mode = requiredString(body, 'mode');
    if (mode !== 'copy' && mode !== 'move')
      throw new DomainError('invalid-body', 400, 'Choose Copy or Move');
    const targetRootId = requiredString(body, 'targetRootId');
    if (busy.has(sourceId) || busy.size >= 4)
      throw new DomainError(
        'organization-conflict',
        409,
        'Organization is busy; try again shortly',
      );
    busy.add(sourceId);
    try {
      const local = await localSource(context, actor, sourceId);
      eligible(local.source);
      const target = catalog.getContentRoot(targetRootId);
      if (!target) throw new DomainError('not-found', 404, 'Target folder not found');
      if (target.libraryId !== local.root.libraryId)
        throw new DomainError('organization-conflict', 409, 'Choose a folder in the same library');
      const medium = await probeRoot(local.root.path);
      const targetMedium = await probeRoot(target.path);
      if (!targetMedium.online) stale();
      if (
        medium.medium === 'icloud' ||
        medium.medium === 'network' ||
        targetMedium.medium === 'icloud' ||
        targetMedium.medium === 'network'
      )
        throw new DomainError(
          'organization-unsupported',
          409,
          'Choose local disk folders; cloud and network folders are not supported',
        );
      const original = catalog.getSource(sourceId);
      if (!original) stale();
      const before = snapshot(original);
      const system =
        PROVENANCE_SYSTEMS.find((entry) => entry.identifier === original.systemId)?.name ??
        original.systemId ??
        'Unknown System';
      // Preserve the extension and original filename; only folder names use matches.
      const extension = extname(original.relativePath);
      const fileName =
        portableSegment(
          basename(original.relativePath, extension),
          120 - Buffer.byteLength(extension, 'utf8'),
        ) + extension;
      const targetRelativePath = [
        portableSegment(system),
        portableSegment(
          original.title ?? basename(original.displayName, extname(original.displayName)),
        ),
        fileName,
      ].join('/');
      const operation = await previewOrganization(
        local.root.path,
        original.relativePath,
        target.path,
        targetRelativePath,
        mode,
      );
      const scanned = catalog.sourceInspectionIdentity(sourceId);
      if (
        !scanned?.filesystemIdentity ||
        scanned.mtimeMs === null ||
        scanned.filesystemIdentity !== operation.file.filesystemIdentity ||
        scanned.size !== operation.file.size ||
        scanned.mtimeMs !== operation.file.mtimeMs
      )
        throw new DomainError(
          'organization-conflict',
          409,
          'Source changed since scanning. Rescan its folder before organizing.',
        );
      const current = catalog.getSource(sourceId);
      if (!current || snapshot(current) !== before) stale();
      const now = Date.now();
      for (const [id, plan] of plans) if (plan.expiresAt <= now) plans.delete(id);
      // Bounded in-memory previews; a fresh preview replaces this owner's prior
      // preview for this source, and old previews are safely disposable.
      for (const [id, plan] of plans)
        if (plan.ownerId === actor.userId && plan.sourceId === sourceId) plans.delete(id);
      if (plans.size >= 128) {
        const first = plans.keys().next().value;
        if (first) plans.delete(first);
      }
      const planId = randomUUID();
      const expiresAt = now + TTL;
      plans.set(planId, {
        ownerId: actor.userId,
        sourceId,
        targetRootId,
        snapshot: before,
        expiresAt,
        operation,
      });
      return {
        planId,
        sourceId,
        mode,
        sourceRootId: local.root.id,
        targetRootId,
        sourceRelativePath: original.relativePath,
        targetRelativePath,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } finally {
      busy.delete(sourceId);
    }
  });
  app.post('/api/v1/sources/:sourceId/organization/apply', async (request) => {
    const actor = requireOwner(request, 'Only an owner can organize original files');
    const sourceId = (request.params as { sourceId: string }).sourceId;
    const body = jsonObject(request.body);
    if (Object.keys(body).some((key) => key !== 'planId'))
      throw new DomainError('invalid-body', 400, 'Only the preview planId is accepted');
    const planId = requiredString(body, 'planId');
    const plan = plans.get(planId);
    if (
      !plan ||
      plan.ownerId !== actor.userId ||
      plan.sourceId !== sourceId ||
      plan.expiresAt <= Date.now()
    )
      stale();
    if (busy.has(sourceId) || busy.size >= 4)
      throw new DomainError('organization-conflict', 409, 'This file is being organized');
    plans.delete(planId);
    busy.add(sourceId);
    let releaseRoots: (() => void) | undefined;
    try {
      const source = catalog.getSource(sourceId);
      if (!source || snapshot(source) !== plan.snapshot) stale();
      eligible(source);
      const root = catalog.getContentRoot(source.rootId);
      const target = catalog.getContentRoot(plan.targetRootId);
      if (
        !root ||
        !target ||
        root.path !== plan.operation.sourceRoot ||
        target.path !== plan.operation.targetRoot ||
        root.libraryId !== target.libraryId
      )
        stale();
      releaseRoots = reserveContentRoots(catalog, [root.id, target.id]);
      try {
        await localSource(context, actor, sourceId);
      } catch {
        stale();
      }
      const medium = await probeRoot(root.path);
      const targetMedium = await probeRoot(target.path);
      if (!targetMedium.online) stale();
      if (
        medium.medium === 'icloud' ||
        medium.medium === 'network' ||
        targetMedium.medium === 'icloud' ||
        targetMedium.medium === 'network'
      )
        stale();
      if (
        catalog
          .listSources(target.id)
          .some((file) => file.relativePath === plan.operation.targetRelativePath)
      )
        stale();
      const operation = await applyOrganization(plan.operation);
      let saved: SourceFileRecord;
      try {
        // Async file work gives other requests an opportunity to change metadata.
        const current = catalog.getSource(sourceId);
        if (!current || snapshot(current) !== plan.snapshot) stale();
        const file = {
          ...source,
          ...operation.file,
          relativePath: plan.operation.targetRelativePath,
          displayName: basename(plan.operation.targetRelativePath),
          availability: 'local' as const,
        };
        const input = { sourceId, targetRootId: target.id, actorId: actor.userId, file };
        saved =
          plan.operation.mode === 'move'
            ? catalog.relocateSource(input)
            : catalog.cloneSource(input);
      } catch (error) {
        await operation.rollback();
        throw error;
      }
      // The catalog now points at verified destination bytes. A crash or unlink
      // failure leaves an extra original, preserving both data and saved identity.
      let warning: string | undefined;
      try {
        await operation.finalize();
      } catch (error) {
        warning =
          error instanceof DomainError && error.code === 'organization-recovery'
            ? error.message
            : 'The destination is indexed with its saved matches. The original could not be removed; inspect both locations before removing the extra file.';
      }
      return {
        sourceId: saved.id,
        originalSourceId: sourceId,
        mode: plan.operation.mode,
        targetRootId: target.id,
        targetRelativePath: saved.relativePath,
        ...(warning ? { warning } : {}),
      };
    } finally {
      releaseRoots?.();
      busy.delete(sourceId);
    }
  });
}
