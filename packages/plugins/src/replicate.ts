import type { RemoteObject } from './connector.js';
import { PluginError } from './errors.js';
import { isSaveKind } from './kinds.js';
import { safeRelativePath } from './paths.js';

export type { RemoteObject };

export interface LocalAsset {
  id: string;
  relativePath: string;
  sha256: string;
  kind: string;
}

export type SyncDirection = 'push' | 'pull' | 'both';

export type ReplicationStep =
  | {
      op: 'upload';
      relativePath: string;
      locator: string;
      kind: string;
      sha256: string;
      size: number;
      keepBoth: boolean;
      baseRevision: number;
    }
  | { op: 'download'; relativePath: string; sha256: string; assetId: string }
  | {
      op: 'skip';
      relativePath: string;
      reason: 'same-digest' | 'connector-read-only' | 'not-requested';
    }
  | { op: 'refuse'; relativePath: string; reason: 'strict-conflict' };

export interface ReplicationReport {
  uploaded: string[];
  downloaded: string[];
  skipped: string[];
  refused: { relativePath: string; reason: string }[];
}

/**
 * Compares a connector's tree with the item manifest. Same bytes are skipped
 * even when a save landed beside the live asset under a conflict name, so a
 * later sync does not upload that save again. A differing ROM is refused. A
 * differing save is uploaded with a stale revision so the server keeps both.
 */
export function planReplication(
  remote: readonly RemoteObject[],
  local: readonly LocalAsset[],
  options: { direction: SyncDirection; writable: boolean; itemRevision: number },
): ReplicationStep[] {
  const remoteObjects = index(remote);
  const localAssets = index(local);
  const localDigests = new Set(local.map((asset) => asset.sha256));
  const remoteDigests = new Set(
    remote.flatMap((object) => (object.sha256 === null ? [] : [object.sha256])),
  );
  const steps: ReplicationStep[] = [];
  const push = options.direction !== 'pull';
  const pull = options.direction !== 'push';

  for (const object of [...remoteObjects.values()].sort(byPath)) {
    if (object.sha256 === null) {
      throw new PluginError('missing-digest', `${object.relativePath} has not been hashed`);
    }
    const existing = localAssets.get(object.relativePath);
    if (localDigests.has(object.sha256)) {
      steps.push({ op: 'skip', relativePath: object.relativePath, reason: 'same-digest' });
      continue;
    }
    if (!push) {
      steps.push({ op: 'skip', relativePath: object.relativePath, reason: 'not-requested' });
      continue;
    }
    if (existing && !isSaveKind(object.kind) && !isSaveKind(existing.kind)) {
      steps.push({ op: 'refuse', relativePath: object.relativePath, reason: 'strict-conflict' });
      continue;
    }
    steps.push({
      op: 'upload',
      relativePath: object.relativePath,
      locator: object.locator,
      kind: object.kind,
      sha256: object.sha256,
      size: object.size,
      keepBoth: existing !== undefined,
      baseRevision: options.itemRevision,
    });
  }

  for (const asset of [...localAssets.values()].sort(byPath)) {
    if (remoteObjects.has(asset.relativePath)) continue;
    if (remoteDigests.has(asset.sha256)) {
      steps.push({ op: 'skip', relativePath: asset.relativePath, reason: 'same-digest' });
      continue;
    }
    if (!pull) {
      steps.push({ op: 'skip', relativePath: asset.relativePath, reason: 'not-requested' });
      continue;
    }
    if (!options.writable) {
      steps.push({ op: 'skip', relativePath: asset.relativePath, reason: 'connector-read-only' });
      continue;
    }
    steps.push({
      op: 'download',
      relativePath: asset.relativePath,
      sha256: asset.sha256,
      assetId: asset.id,
    });
  }
  return assignBaseRevisions(steps, options.itemRevision);
}

/**
 * Each completed upload advances the item revision by one, including a save
 * that is kept beside the live asset. The next new file has to ask for that
 * new revision, or the server treats it as a conflict. A kept save asks for
 * revision 0 on purpose: matching the current revision would replace the live
 * bytes, and arrival order is not play order.
 */
export function assignBaseRevisions(
  steps: readonly ReplicationStep[],
  itemRevision: number,
): ReplicationStep[] {
  let revision = itemRevision;
  return steps.map((step) => {
    if (step.op !== 'upload') return step;
    if (step.keepBoth) {
      revision += 1;
      return { ...step, baseRevision: 0 };
    }
    const baseRevision = revision;
    revision += 1;
    return { ...step, baseRevision };
  });
}

function index<T extends { relativePath: string; sha256: string | null }>(
  items: readonly T[],
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const relativePath = safeRelativePath(item.relativePath);
    if (map.has(relativePath)) {
      throw new PluginError('ambiguous-path', `${relativePath} is listed twice`);
    }
    map.set(relativePath, item.relativePath === relativePath ? item : { ...item, relativePath });
  }
  return map;
}

function byPath(a: { relativePath: string }, b: { relativePath: string }): number {
  return a.relativePath.localeCompare(b.relativePath);
}
