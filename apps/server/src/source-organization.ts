import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { type Actor, DomainError, type SourceFileRecord } from '@ecs/domain';
import { PROVENANCE_SYSTEMS } from '@ecs/protocol';
import {
  applyOrganization,
  inspectOrganizationFile,
  type OrganizationPlan,
  portableSegment,
  previewOrganization,
  probeRoot,
  resolveInside,
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

export interface AutomaticOrganizationOutcome {
  status: 'copied' | 'moved' | 'synchronized' | 'skipped' | 'failed';
  sourceId?: string;
  warning?: string;
}
type Owner = Actor & { kind: 'user' };
const automatic = new WeakMap<
  ServerContext['catalog'],
  (
    actor: Owner,
    sourceId: string,
    pendingLocalKinds: readonly string[],
  ) => Promise<AutomaticOrganizationOutcome | undefined>
>();
/** A saved selection is already committed. Organization errors must never undo it. */
export async function runAutomaticOrganization(
  context: Pick<ServerContext, 'catalog'>,
  actor: Actor,
  sourceId: string,
  pendingLocalKinds: readonly string[] = [],
): Promise<AutomaticOrganizationOutcome | undefined> {
  if (actor.kind !== 'user' || !actor.isOwner) return;
  try {
    return await automatic.get(context.catalog)?.(actor, sourceId, pendingLocalKinds);
  } catch {
    return {
      status: 'failed',
      warning:
        'Match saved. Automatic organization could not complete; preview the file organization to inspect the destination.',
    };
  }
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
  async function prepare(
    actor: Owner,
    sourceId: string,
    mode: 'copy' | 'move',
    targetRootId: string,
  ) {
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
  }
  async function execute(
    actor: Owner,
    sourceId: string,
    planId: string,
    validate?: () => void,
    organizationCopy?: { sourceRootId: string; originalIdentity: string; sha256: string },
  ) {
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
      validate?.();
      const operation = await applyOrganization(plan.operation);
      let saved: SourceFileRecord;
      try {
        // Async file work gives other requests an opportunity to change metadata.
        validate?.();
        const current = catalog.getSource(sourceId);
        if (!current || snapshot(current) !== plan.snapshot) stale();
        const file = {
          ...source,
          ...operation.file,
          relativePath: plan.operation.targetRelativePath,
          displayName: basename(plan.operation.targetRelativePath),
          availability: 'local' as const,
        };
        const input = {
          sourceId,
          targetRootId: target.id,
          actorId: actor.userId,
          file,
          ...(organizationCopy ? { organizationCopy } : {}),
        };
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
  }
  app.post('/api/v1/sources/:sourceId/organization/preview', async (request) => {
    const actor = requireOwner(request, 'Only an owner can organize original files');
    const sourceId = (request.params as { sourceId: string }).sourceId;
    const body = jsonObject(request.body);
    if (Object.keys(body).some((key) => !['mode', 'targetRootId'].includes(key)))
      throw new DomainError('invalid-body', 400, 'Only mode and targetRootId are accepted');
    const mode = requiredString(body, 'mode');
    if (mode !== 'copy' && mode !== 'move')
      throw new DomainError('invalid-body', 400, 'Choose Copy or Move');
    return prepare(actor, sourceId, mode, requiredString(body, 'targetRootId'));
  });
  app.post('/api/v1/sources/:sourceId/organization/apply', async (request) => {
    const actor = requireOwner(request, 'Only an owner can organize original files');
    const body = jsonObject(request.body);
    if (Object.keys(body).some((key) => key !== 'planId'))
      throw new DomainError('invalid-body', 400, 'Only the preview planId is accepted');
    return execute(
      actor,
      (request.params as { sourceId: string }).sourceId,
      requiredString(body, 'planId'),
    );
  });
  function policyView(rootId: string) {
    const policy = catalog.getSourceOrganizationPolicy(rootId);
    return {
      sourceRootId: rootId,
      enabled: !!policy,
      ...(policy
        ? { mode: policy.mode, targetRootId: policy.targetRootId, enabledAt: policy.enabledAt }
        : {}),
    };
  }
  app.get('/api/v1/roots/:rootId/organization-policy', async (request, reply) => {
    requireOwner(request, 'Only an owner can manage automatic organization');
    const rootId = (request.params as { rootId: string }).rootId;
    if (!catalog.getContentRoot(rootId))
      throw new DomainError('not-found', 404, 'Folder not found');
    reply.header('cache-control', 'private, no-store');
    return policyView(rootId);
  });
  app.put('/api/v1/roots/:rootId/organization-policy', async (request) => {
    const actor = requireOwner(request, 'Only an owner can manage automatic organization');
    const rootId = (request.params as { rootId: string }).rootId;
    const body = jsonObject(request.body);
    if (
      Object.keys(body).some((key) => !['enabled', 'planId'].includes(key)) ||
      typeof body.enabled !== 'boolean'
    )
      throw new DomainError('invalid-body', 400, 'Supply enabled and a preview planId to enable');
    if (!catalog.getContentRoot(rootId))
      throw new DomainError('not-found', 404, 'Folder not found');
    if (!body.enabled) {
      catalog.clearSourceOrganizationPolicy(rootId);
      return policyView(rootId);
    }
    const planId = requiredString(body, 'planId');
    const plan = plans.get(planId);
    if (!plan || plan.ownerId !== actor.userId || plan.expiresAt <= Date.now()) stale();
    const source = catalog.getSource(plan.sourceId);
    if (!source || source.rootId !== rootId || snapshot(source) !== plan.snapshot) stale();
    const root = catalog.getContentRoot(rootId);
    const target = catalog.getContentRoot(plan.targetRootId);
    if (
      !root ||
      !target ||
      root.path !== plan.operation.sourceRoot ||
      target.path !== plan.operation.targetRoot ||
      root.libraryId !== target.libraryId
    )
      stale();
    const release = reserveContentRoots(catalog, [root.id, target.id]);
    try {
      // Fresh validation confirms the sample still means exactly what the owner saw.
      const fresh = await prepare(actor, source.id, plan.operation.mode, target.id);
      const refreshed = plans.get(fresh.planId);
      const currentSource = catalog.getSource(source.id);
      if (
        !refreshed ||
        !currentSource ||
        refreshed.operation.file.validator !== plan.operation.file.validator ||
        refreshed.operation.targetRelativePath !== plan.operation.targetRelativePath ||
        snapshot(currentSource) !== plan.snapshot
      )
        stale();
      catalog.setSourceOrganizationPolicy({
        sourceRootId: root.id,
        libraryId: root.libraryId,
        targetRootId: target.id,
        sourceRootPath: root.path,
        targetRootPath: target.path,
        mode: plan.operation.mode,
        enabledBy: actor.userId,
        enabledAt: new Date().toISOString(),
      });
      plans.delete(fresh.planId);
      plans.delete(planId);
      return policyView(rootId);
    } finally {
      release();
    }
  });
  automatic.set(catalog, async (actor, sourceId, pendingLocalKinds) => {
    const source = catalog.getSource(sourceId);
    if (!source) return;
    const policy = catalog.getSourceOrganizationPolicy(source.rootId);
    if (!policy) return;
    // Keep local companion proposals usable until their selected snapshots are saved.
    if (
      policy.mode === 'move' &&
      pendingLocalKinds.some((kind) => ['metadata', 'artwork'].includes(kind))
    )
      return { status: 'skipped', sourceId };
    const root = catalog.getContentRoot(source.rootId);
    const target = catalog.getContentRoot(policy.targetRootId);
    if (
      !root ||
      !target ||
      root.libraryId !== policy.libraryId ||
      target.libraryId !== policy.libraryId ||
      root.path !== policy.sourceRootPath ||
      target.path !== policy.targetRootPath
    )
      stale();
    const policySnapshot = JSON.stringify(policy);
    const stillEnabled = () => {
      if (JSON.stringify(catalog.getSourceOrganizationPolicy(root.id)) !== policySnapshot) stale();
    };
    const owned =
      policy.mode === 'copy' ? catalog.getSourceOrganizationCopy(root.id, sourceId) : null;
    if (owned) {
      const release = reserveContentRoots(catalog, [root.id, target.id]);
      try {
        const copy = catalog.getSource(owned.copySourceId);
        if (!copy || copy.rootId !== target.id) stale();
        const before = snapshot(source);
        const copyBefore = snapshot(copy);
        const media = await Promise.all([probeRoot(root.path), probeRoot(target.path)]);
        if (
          media.some(
            (medium) => !medium.online || medium.medium === 'icloud' || medium.medium === 'network',
          )
        )
          stale();
        const [originalFile, copyFile] = await Promise.all([
          resolveInside(root.path, source.relativePath, { pinnedRoot: true }).then(
            inspectOrganizationFile,
          ),
          resolveInside(target.path, copy.relativePath, { pinnedRoot: true }).then(
            inspectOrganizationFile,
          ),
        ]);
        if (
          originalFile.filesystemIdentity !== owned.originalIdentity ||
          copyFile.filesystemIdentity !== owned.copyIdentity ||
          originalFile.sha256 !== owned.sha256 ||
          copyFile.sha256 !== owned.sha256
        )
          stale();
        stillEnabled();
        const currentSource = catalog.getSource(sourceId);
        const currentCopy = catalog.getSource(copy.id);
        if (
          !currentSource ||
          !currentCopy ||
          snapshot(currentSource) !== before ||
          snapshot(currentCopy) !== copyBefore
        )
          stale();
        catalog.synchronizeSourceMatches(sourceId, copy.id);
        return { status: 'synchronized', sourceId: copy.id };
      } finally {
        release();
      }
    }
    eligible(source);
    // A later match in a same-root move should not attempt to overwrite itself.
    const system =
      PROVENANCE_SYSTEMS.find((entry) => entry.identifier === source.systemId)?.name ??
      source.systemId ??
      'Unknown System';
    const extension = extname(source.relativePath);
    const fileName =
      portableSegment(
        basename(source.relativePath, extension),
        120 - Buffer.byteLength(extension, 'utf8'),
      ) + extension;
    const destination = [
      portableSegment(system),
      portableSegment(source.title ?? basename(source.displayName, extname(source.displayName))),
      fileName,
    ].join('/');
    if (source.rootId === target.id && source.relativePath === destination)
      return { status: 'skipped', sourceId };
    const preview = await prepare(actor, sourceId, policy.mode, target.id);
    stillEnabled();
    const originalIdentity = plans.get(preview.planId)?.operation.file;
    const result = await execute(
      actor,
      sourceId,
      preview.planId,
      stillEnabled,
      policy.mode === 'copy' && originalIdentity
        ? {
            sourceRootId: root.id,
            originalIdentity: originalIdentity.filesystemIdentity,
            sha256: originalIdentity.sha256,
          }
        : undefined,
    );
    return {
      status: policy.mode === 'copy' ? 'copied' : 'moved',
      sourceId: result.sourceId,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  });
}
