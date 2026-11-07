import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { type Actor, DomainError, type SourceFileRecord } from '@ecs/domain';
import { PROVENANCE_SYSTEMS } from '@ecs/protocol';
import {
  applyOrganizationGroup,
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
import {
  organizationFiles,
  organizationPaths,
  validateOrganizationGroups,
} from './organization-files.js';
import { reserveContentRoots } from './root-mutations.js';
import { localSource } from './source-groups.js';

const TTL = 10 * 60 * 1000;
interface SavedPlan {
  ownerId: string;
  sourceId: string;
  targetRootId: string;
  snapshot: string;
  expiresAt: number;
  operation: OrganizationPlan;
  members: { sourceId: string; operation: OrganizationPlan }[];
}
type Mode = OrganizationPlan['mode'];
interface FolderPlan {
  ownerId: string;
  rootId: string;
  targetRootId: string;
  mode: Mode;
  snapshot: string;
  expiresAt: number;
}

export async function organizationFolderIdentity(path: string) {
  const medium = await probeRoot(path);
  if (medium.medium === 'icloud' || medium.medium === 'network') {
    throw new DomainError(
      'organization-unsupported',
      409,
      'Automatic organization requires local disk folders. Turn off automatic organization to add a cloud or network folder.',
    );
  }
  const info = await lstat(path, { bigint: true }).catch(() => null);
  if (!medium.online || !info?.isDirectory() || (await realpath(path).catch(() => null)) !== path)
    throw new DomainError('organization-conflict', 409, 'The folder is unavailable or changed');
  return { device: String(info.dev), identity: `${info.dev}:${info.ino}:${info.birthtimeNs}` };
}

function destination(source: SourceFileRecord): string {
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
  return [
    portableSegment(system),
    portableSegment(source.title ?? basename(source.displayName, extname(source.displayName))),
    fileName,
  ].join('/');
}

function organizationDraft(input: unknown) {
  const body = jsonObject(input);
  if (Object.keys(body).some((key) => !['mode', 'targetRootId'].includes(key)))
    throw new DomainError('invalid-body', 400, 'Only mode and targetRootId are accepted');
  const mode = requiredString(body, 'mode');
  if (mode !== 'copy' && mode !== 'move')
    throw new DomainError('invalid-body', 400, 'Choose Copy or Move');
  return { mode, targetRootId: requiredString(body, 'targetRootId') } satisfies {
    mode: Mode;
    targetRootId: string;
  };
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
  const folderPlans = new Map<string, FolderPlan>();
  const busy = new Set<string>();
  const group = (source: SourceFileRecord) =>
    organizationFiles(source, catalog.listSources(source.rootId));
  const snapshot = (source: SourceFileRecord) =>
    JSON.stringify(
      group(source).map((file) => ({ file, matches: catalog.sourceMatches(file.id) })),
    );
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
      const indexed = catalog.listSources(local.root.id);
      const files = organizationFiles(local.source, indexed);
      await validateOrganizationGroups(local.root.path, files, indexed);
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
      const paths = organizationPaths(original, files, destination);
      const members: SavedPlan['members'] = [];
      for (const file of files) {
        await localSource(context, actor, file.id);
        const targetRelativePath = paths.get(file.id);
        if (!targetRelativePath) stale();
        const operation = await previewOrganization(
          local.root.path,
          file.relativePath,
          target.path,
          targetRelativePath,
          mode,
        );
        const scanned = catalog.sourceInspectionIdentity(file.id);
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
        members.push({ sourceId: file.id, operation });
      }
      const operation = members.find((member) => member.sourceId === sourceId)?.operation;
      if (!operation) stale();
      const targetRelativePath = operation.targetRelativePath;
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
        members,
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
        files: members.map(({ operation }) => ({
          sourceRelativePath: operation.sourceRelativePath,
          targetRelativePath: operation.targetRelativePath,
        })),
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
    organizationCopy = false,
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
      const files = group(source);
      if (
        JSON.stringify(files.map((file) => file.id)) !==
        JSON.stringify(plan.members.map((member) => member.sourceId))
      )
        stale();
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
        for (const file of files) await localSource(context, actor, file.id);
        await validateOrganizationGroups(root.path, files, catalog.listSources(root.id));
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
          .some((file) =>
            plan.members.some(
              (member) => member.operation.targetRelativePath === file.relativePath,
            ),
          )
      )
        stale();
      validate?.();
      const operation = await applyOrganizationGroup(
        plan.members.map((member) => member.operation),
      );
      let saved: SourceFileRecord;
      try {
        // Async file work gives other requests an opportunity to change metadata.
        validate?.();
        const current = catalog.getSource(sourceId);
        if (!current || snapshot(current) !== plan.snapshot) stale();
        const paths = new Map(
          plan.members.map((member) => [
            member.operation.sourceRelativePath,
            member.operation.targetRelativePath,
          ]),
        );
        const inputs = plan.members.map((member, index) => {
          const source = files.find((file) => file.id === member.sourceId);
          const placed = operation.files[index];
          if (!source || !placed) stale();
          const path = (value: string) => {
            const target = paths.get(value);
            if (!target) stale();
            return target;
          };
          return {
            sourceId: source.id,
            targetRootId: target.id,
            actorId: actor.userId,
            file: {
              ...source,
              ...placed,
              relativePath: member.operation.targetRelativePath,
              displayName: basename(member.operation.targetRelativePath),
              availability: 'local' as const,
              groupAnchor: source.groupAnchor ? path(source.groupAnchor) : null,
              groupMembers: source.groupMembers?.map(path) ?? [],
            },
            ...(organizationCopy
              ? {
                  organizationCopy: {
                    sourceRootId: root.id,
                    originalIdentity: member.operation.file.filesystemIdentity,
                    sha256: member.operation.file.sha256,
                  },
                }
              : {}),
          };
        });
        const first = inputs[0];
        if (!first) stale();
        const transferred =
          inputs.length > 1
            ? catalog.transferSourceGroup(inputs, plan.operation.mode === 'copy')
            : [
                plan.operation.mode === 'move'
                  ? catalog.relocateSource(first)
                  : catalog.cloneSource(first),
              ];
        const index = plan.members.findIndex((member) => member.sourceId === sourceId);
        const selected = transferred[index];
        if (!selected) stale();
        saved = selected;
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
    const { mode, targetRootId } = organizationDraft(request.body);
    return prepare(actor, sourceId, mode, targetRootId);
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
  async function folderPreview(rootId: string, targetRootId: string, mode: Mode) {
    const root = catalog.getContentRoot(rootId);
    const target = catalog.getContentRoot(targetRootId);
    if (!root || !target) throw new DomainError('not-found', 404, 'Folder not found');
    if (root.libraryId !== target.libraryId)
      throw new DomainError('organization-conflict', 409, 'Choose a folder in the same library');
    const from = await organizationFolderIdentity(root.path);
    const to = rootId === targetRootId ? from : await organizationFolderIdentity(target.path);
    if (mode === 'move' && from.device !== to.device)
      throw new DomainError(
        'organization-conflict',
        409,
        'Moving between volumes is not supported; use Copy instead',
      );

    const sources = catalog.listSources(rootId);
    const visited = new Set<string>();
    const examples: { sourceRelativePath: string; targetRelativePath: string }[] = [];
    for (const source of sources) {
      if (visited.has(source.id)) continue;
      let files: SourceFileRecord[];
      try {
        files = organizationFiles(source, sources);
      } catch {
        continue;
      }
      const paths = organizationPaths(source, files, destination);
      for (const file of files) {
        visited.add(file.id);
        const targetRelativePath = paths.get(file.id);
        if (
          !targetRelativePath ||
          (rootId === targetRootId && targetRelativePath === file.relativePath)
        )
          continue;
        examples.push({ sourceRelativePath: file.relativePath, targetRelativePath });
        if (examples.length === 5) break;
      }
      if (examples.length === 5) break;
    }
    return { root, target, examples, snapshot: JSON.stringify([root, target, from, to, examples]) };
  }
  app.post('/api/v1/roots/:rootId/organization-policy/preview', async (request, reply) => {
    const actor = requireOwner(request, 'Only an owner can manage automatic organization');
    const { rootId } = request.params as { rootId: string };
    const { mode, targetRootId } = organizationDraft(request.body);
    const { snapshot, examples } = await folderPreview(rootId, targetRootId, mode);
    const now = Date.now();
    for (const [id, plan] of folderPlans) if (plan.expiresAt <= now) folderPlans.delete(id);
    const oldest = folderPlans.keys().next().value;
    if (folderPlans.size >= 128 && oldest) folderPlans.delete(oldest);
    const planId = randomUUID();
    folderPlans.set(planId, {
      ownerId: actor.userId,
      rootId,
      targetRootId,
      mode,
      snapshot,
      expiresAt: now + TTL,
    });
    reply.header('cache-control', 'private, no-store');
    return { planId, examples };
  });
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
    const folderPlan = folderPlans.get(planId);
    if (folderPlan) {
      if (
        folderPlan.ownerId !== actor.userId ||
        folderPlan.rootId !== rootId ||
        folderPlan.expiresAt <= Date.now()
      )
        stale();
      const release = reserveContentRoots(catalog, [rootId, folderPlan.targetRootId]);
      try {
        const { root, target, snapshot } = await folderPreview(
          rootId,
          folderPlan.targetRootId,
          folderPlan.mode,
        );
        if (
          snapshot !== folderPlan.snapshot ||
          folderPlans.get(planId) !== folderPlan ||
          folderPlan.expiresAt <= Date.now()
        )
          stale();
        catalog.setSourceOrganizationPolicy({
          sourceRootId: rootId,
          libraryId: root.libraryId,
          targetRootId: target.id,
          sourceRootPath: root.path,
          targetRootPath: target.path,
          mode: folderPlan.mode,
          enabledBy: actor.userId,
          enabledAt: new Date().toISOString(),
        });
        folderPlans.delete(planId);
        return policyView(rootId);
      } finally {
        release();
      }
    }
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
        JSON.stringify(refreshed.members) !== JSON.stringify(plan.members) ||
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
        const originals = group(source);
        const pairs = originals.map((original) => {
          const ownership = catalog.getSourceOrganizationCopy(root.id, original.id);
          const copy = ownership && catalog.getSource(ownership.copySourceId);
          if (!ownership || !copy || copy.rootId !== target.id) stale();
          return { original, copy, ownership };
        });
        const before = snapshot(source);
        const copy = catalog.getSource(owned.copySourceId);
        if (!copy) stale();
        const copyBefore = snapshot(copy);
        if (
          group(copy).length !== pairs.length ||
          group(copy).some((file) => !pairs.some((pair) => pair.copy.id === file.id))
        )
          stale();
        const media = await Promise.all([probeRoot(root.path), probeRoot(target.path)]);
        if (
          media.some(
            (medium) => !medium.online || medium.medium === 'icloud' || medium.medium === 'network',
          )
        )
          stale();
        await validateOrganizationGroups(root.path, originals, catalog.listSources(root.id));
        await validateOrganizationGroups(
          target.path,
          pairs.map((pair) => pair.copy),
          catalog.listSources(target.id),
        );
        for (const { original, copy, ownership } of pairs) {
          const originalFile = await inspectOrganizationFile(
            await resolveInside(root.path, original.relativePath, { pinnedRoot: true }),
          );
          const copyFile = await inspectOrganizationFile(
            await resolveInside(target.path, copy.relativePath, { pinnedRoot: true }),
          );
          if (
            originalFile.filesystemIdentity !== ownership.originalIdentity ||
            copyFile.filesystemIdentity !== ownership.copyIdentity ||
            originalFile.sha256 !== ownership.sha256 ||
            copyFile.sha256 !== ownership.sha256
          )
            stale();
        }
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
        catalog.synchronizeSourceGroupMatches(
          pairs.map(({ original, copy }) => ({ originalId: original.id, copyId: copy.id })),
        );
        return { status: 'synchronized', sourceId: copy.id };
      } finally {
        release();
      }
    }
    const files = group(source);
    // A later match in a same-root move should not attempt to overwrite itself.
    const paths = organizationPaths(source, files, destination);
    if (
      source.rootId === target.id &&
      files.every((file) => file.relativePath === paths.get(file.id))
    )
      return { status: 'skipped', sourceId };
    const preview = await prepare(actor, sourceId, policy.mode, target.id);
    stillEnabled();
    const result = await execute(
      actor,
      sourceId,
      preview.planId,
      stillEnabled,
      policy.mode === 'copy',
    );
    return {
      status: policy.mode === 'copy' ? 'copied' : 'moved',
      sourceId: result.sourceId,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  });
}
